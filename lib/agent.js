/**
 * lib/agent.js
 * ----------------------------------------------------------------------------
 * The "brain". Pure logic, no HTTP framework, so it can be unit-tested and
 * reused from anywhere (the Vercel function, a CLI, a cron job).
 *
 * The single job of this agent: turn a spoken question into something that
 * reads well inside an iOS notification banner. That means:
 *   - a short title (notification headline)
 *   - a short answer (notification body, no markdown, no bullet lists)
 *   - a longer "detail" string for when you tap through / view in the app
 */

import { toolSchemas, runTool, isToolsEnabled, availableTools } from './tools/index.js';

export const DEFAULT_MODEL = 'gpt-4o-mini';
export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Words allowed in the notification body before we start truncating. */
export const DEFAULT_MAX_WORDS = 60;

export class AgentError extends Error {
  constructor(message, status = 500, detail) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Build the system prompt.
 * @param {{maxWords?: number, persona?: string, now?: Date, timeZone?: string}} opts
 */
export function buildSystemPrompt(opts = {}) {
  const maxWords = opts.maxWords || DEFAULT_MAX_WORDS;
  const now = opts.now || new Date();
  const timeZone = opts.timeZone || 'UTC';

  let stamp;
  try {
    stamp = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone,
    }).format(now);
  } catch {
    stamp = now.toISOString();
  }

  const lines = [
    'You are Oscar, a voice assistant. The user speaks a question to their iPhone',
    'and your reply is shown as a push notification, so it must be readable at a',
    'glance on a lock screen.',
    '',
    'Rules:',
    `- "answer" must be at most ${maxWords} words, plain conversational prose.`,
    '- No markdown, no asterisks, no bullet points, no headings, no emoji, no code fences.',
    '- Lead with the actual answer. Never open with "Sure", "Great question", or a restatement.',
    '- If the question is ambiguous, answer the most likely reading rather than asking back.',
    '- If you truly do not know or it depends on live data you lack, say so in one sentence.',
    '- The input came from speech-to-text, so expect homophones and missing punctuation.',
    '  Silently correct obvious transcription errors instead of commenting on them.',
    '- "title" is a notification headline: at most 5 words, no trailing period.',
    '- "detail" may be longer (a few sentences) for when the user opens the full result.',
    '  Leave it as an empty string when the short answer already says everything.',
    '',
    `For reference, the current date and time is ${stamp} (${timeZone}).`,
  ];

  if (opts.tools) {
    lines.push(
      '',
      'You have tools for live data. Use them rather than guessing:',
      '- Anything about weather, temperature, rain, or the forecast needs get_weather.',
      '- Anything about where the user is needs get_location.',
      '- Their schedule, meetings, or whether they are free needs list_events.',
      '- Their to-do list, what is due, or what they need to do needs list_tasks.',
      '- Their email, messages, or who wrote to them needs search_email.',
      'Never invent an id. To act on a specific email or task, look it up first.',
      'Call a tool at most twice before answering. If a tool reports an approximate',
      'location, say so briefly ("roughly", "around"). Never read out raw coordinates —',
      'use the place name. Always state the unit with a temperature.'
    );

    if (opts.canWrite) {
      lines.push(
        '',
        'You can also change things: create events, add or tick off tasks, draft and send email.',
        'Only do so when the user actually asked for it — never as a helpful extra.',
        'Prefer draft_email over send_email unless they clearly said to send it.',
        'After any change, state plainly what you did so they can check it.',
        opts.requireConfirm === false
          ? 'Deleting takes effect immediately, with no confirmation step. Be certain you have the'
          : 'Deleting is safe to attempt: the user is asked to confirm before anything is removed,',
        opts.requireConfirm === false
          ? 'right thing before you call a delete tool.'
          : 'so you never need to ask "are you sure" yourself.',
        'Either way you need the right id — look it up first, and if more than one thing could',
        'match what they said, ask which one rather than picking.'
      );
    }
  }

  if (opts.persona && String(opts.persona).trim()) {
    lines.push('', 'Additional standing instructions from the user:', String(opts.persona).trim());
  }

  lines.push(
    '',
    'Respond with a JSON object using exactly these keys: title, answer, detail.'
  );

  return lines.join('\n');
}

/** Collapse whitespace and strip characters that look wrong in a notification. */
export function tidy(text) {
  return String(text ?? '')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hard cap on words, ending on a whole word with an ellipsis. */
export function clampWords(text, maxWords) {
  const words = tidy(text).split(' ').filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ') + '…';
}

/**
 * The model is asked for JSON, but never trust that completely.
 * Falls back to treating the whole thing as the answer text.
 */
export function parseModelPayload(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { title: 'Oscar', answer: 'No answer came back.', detail: '' };

  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        obj = JSON.parse(text.slice(start, end + 1));
      } catch {
        obj = null;
      }
    }
  }

  if (obj && typeof obj === 'object') {
    return {
      title: tidy(obj.title) || 'Oscar',
      answer: tidy(obj.answer) || tidy(obj.detail) || 'No answer came back.',
      detail: tidy(obj.detail),
    };
  }

  return { title: 'Oscar', answer: tidy(text), detail: '' };
}

/**
 * How many times the model may call tools before it must answer.
 * Three, because the deepest real chain is: look it up, act on it, answer —
 * e.g. "delete the event on Thursday" needs list_events then delete_event.
 */
export const MAX_TOOL_ROUNDS = 3;

/**
 * One request to the chat completions API, with the error handling every call
 * site needs. Split out because the tool loop calls it repeatedly.
 */
async function callOpenAI(body, { apiKey, doFetch, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await doFetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new AgentError('The agent took too long to answer.', 504);
    }
    throw new AgentError('Could not reach the model provider.', 502, String(err && err.message));
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text();

  if (!res.ok) {
    let detail = rawText.slice(0, 500);
    try {
      const parsed = JSON.parse(rawText);
      detail = (parsed.error && parsed.error.message) || detail;
    } catch {
      /* keep raw */
    }
    const status = res.status === 429 ? 429 : res.status >= 500 ? 502 : 400;
    throw new AgentError('The model provider returned an error.', status, detail);
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new AgentError('Unreadable response from the model provider.', 502);
  }
}

/**
 * Ask the agent a question.
 *
 * @param {{question: string, timeZone?: string, coords?: object, ip?: string, tools?: boolean}} input
 * @param {{env?: object, fetchImpl?: Function, toolFetchImpl?: Function, timeoutMs?: number}} [deps]
 */
export async function askAgent(input, deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const timeoutMs = deps.timeoutMs || 45000;

  const question = tidy(input && input.question);
  if (!question) throw new AgentError('Missing question.', 400);
  if (question.length > 4000) throw new AgentError('Question is too long.', 413);

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new AgentError('Server is missing OPENAI_API_KEY.', 500);

  const model = env.OPENAI_MODEL || DEFAULT_MODEL;
  const maxWords = Number(env.OSCAR_MAX_WORDS) || DEFAULT_MAX_WORDS;

  const canWrite = input.canWrite === true;
  const useTools = isToolsEnabled(env) && input.tools !== false;
  const availableCount = useTools ? availableTools({ canWrite }, env).length : 0;

  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt({
        maxWords,
        persona: env.OSCAR_PERSONA,
        timeZone: input.timeZone || env.OSCAR_TIMEZONE || 'UTC',
        tools: useTools && availableCount > 0,
        canWrite,
        requireConfirm: input.requireConfirm,
      }),
    },
    { role: 'user', content: question },
  ];

  const toolContext = {
    coords: input.coords || null,
    ip: input.ip || null,
    timeZone: input.timeZone || env.OSCAR_TIMEZONE || null,
    now: input.now ?? Date.now(),
    canWrite,
    confirmed: input.confirmed === true,
    // undefined means "ask" — see the gate in lib/tools/index.js
    requireConfirm: input.requireConfirm,
    env,
    // Tools use the real fetch even in tests that stub the OpenAI one, unless a
    // caller deliberately overrides it.
    fetchImpl: deps.toolFetchImpl || deps.fetchImpl || globalThis.fetch,
  };

  const started = Date.now();
  const toolsUsed = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let lastModel = model;

  /**
   * Bounded on purpose. Each round is a full model round trip, and your phone
   * is waiting — two rounds covers "find where I am, then get the weather",
   * which is the deepest chain these tools need. Without a cap, a confused
   * model can ping-pong tool calls until the request times out.
   */
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const offerTools = useTools && round < MAX_TOOL_ROUNDS;

    const payload = await callOpenAI(
      {
        model,
        messages,
        ...(offerTools && availableCount
          ? { tools: toolSchemas({ canWrite }, env), tool_choice: 'auto' }
          : {}),
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 700,
      },
      { apiKey, doFetch, timeoutMs }
    );

    lastModel = payload.model || model;
    if (payload.usage) {
      usage.prompt_tokens += payload.usage.prompt_tokens || 0;
      usage.completion_tokens += payload.usage.completion_tokens || 0;
      usage.total_tokens += payload.usage.total_tokens || 0;
    }

    const choice = (payload.choices && payload.choices[0]) || {};
    const message = choice.message || {};
    const calls = message.tool_calls || [];

    if (!calls.length) {
      const parsed = parseModelPayload(message.content);
      return {
        title: clampWords(parsed.title, 8) || 'Oscar',
        answer: clampWords(parsed.answer, maxWords),
        detail: parsed.detail,
        model: lastModel,
        elapsedMs: Date.now() - started,
        usage: usage.total_tokens ? usage : null,
        toolsUsed,
      };
    }

    // The assistant turn carrying the tool calls has to go back verbatim, or
    // the follow-up tool messages have nothing to attach to.
    messages.push(message);

    // Independent calls, so run them together rather than one after another.
    const results = await Promise.all(
      calls.map((call) =>
        runTool(call.function && call.function.name, call.function && call.function.arguments, toolContext)
      )
    );

    // If any tool wants confirmation, stop here and hand the prompt straight
    // back. Deliberately NOT another model round trip: the prompt already names
    // exactly what will be destroyed, and letting the model paraphrase it risks
    // it saying "the dentist appointment" when the id points at something else.
    // It also saves a second or two on a request the user is waiting on.
    const pending = results.find((r) => r && r.confirmation);
    if (pending) {
      calls.forEach((call, i) => {
        if (results[i] && results[i].confirmation) toolsUsed.push(call.function.name);
      });
      return {
        title: 'Confirm',
        answer: pending.confirmation.prompt,
        detail: '',
        model: lastModel,
        elapsedMs: Date.now() - started,
        usage: usage.total_tokens ? usage : null,
        toolsUsed,
        pendingConfirmation: pending.confirmation,
      };
    }

    calls.forEach((call, i) => {
      const name = (call.function && call.function.name) || 'unknown';
      const outcome = results[i];
      toolsUsed.push(name);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(outcome.error ? { error: outcome.error } : outcome.result),
      });
    });
  }

  // Unreachable in practice: the final round runs with tools withheld, so the
  // model has to answer. Here for safety rather than optimism.
  throw new AgentError('The agent kept calling tools without answering.', 500);
}
