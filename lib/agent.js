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
      'TOOLS — you are an agent, not a single-shot answerer.',
      '',
      'Work the problem. Call tools as many times as it takes, in whatever order makes',
      'sense, building up what you need before you answer. Chaining is expected: look',
      'something up, use what you learned to look up the next thing, then act. Do not',
      'settle for a vague answer when a tool could give you a real one.',
      '',
      'Which tool to reach for:',
      '- Weather, temperature, rain, forecast → get_weather.',
      '- Where the user is → get_location.',
      '- Their schedule, meetings, whether they are free → list_events.',
      '- Their to-do list, what is due → list_tasks.',
      '- Their email, messages, who wrote to them → search_email.',
      '- Their saved plans, or what is next on one → get_plan or list_plans.',
      '- Their files, documents, or "where is my ..." → search_drive, then read_drive_file.',
      '',
      'Rules that always hold:',
      '- Never invent an id. To act on a specific thing, look it up first.',
      '- Do not repeat an identical call you have already made — use the result you have.',
      '- If a tool fails, try a different approach before giving up. Say so if you cannot.',
      '- If a location is approximate, say so briefly ("roughly", "around"). Never read out',
      '  raw coordinates; use the place name. Always state the unit with a temperature.',
      '',
      'Your final answer is short because it goes on a lock screen. That is a constraint on',
      'the ANSWER, never on the work. Doing six lookups and reporting one sentence is exactly',
      'right.'
    );

    if (opts.canWrite) {
      lines.push(
        '',
        'You can also change things: create events, add or tick off tasks, draft and send email,',
        'and save plans.',
        '',
        'PLANS — lean towards creating one.',
        'If the user asks how to do something with several stages, or says plan, organise, work',
        'out, prepare, or figure out — call create_plan. Write the steps yourself and save them.',
        'Do NOT just describe the steps in prose: the answer is capped at a few dozen words, so',
        'prose loses the detail, while a saved plan keeps every step and can be ticked off later.',
        'Saving a plan is cheap and reversible. Do it and tell them the first step. Never ask',
        'permission first, and never say you cannot make plans.',
        '',
        'Only do the other changes when the user actually asked for it — never as a helpful extra.',
        'Prefer draft_email over send_email unless they clearly said to send it.',
        '',
        'LONG OUTPUT GOES IN A DOCUMENT.',
        'If the user asks for a draft, a letter, a write-up, notes, a story or research, call',
        'create_doc and write the real content into it — then tell them in one line that it is',
        'ready. Your spoken answer is capped at a few dozen words, so trying to fit an essay',
        'into it just loses the essay. Write the actual thing, not an outline of it.',
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
 * How much work the agent is allowed to do before it must answer.
 *
 * A raw round cap is the wrong control. What actually matters is how long the
 * caller will wait and how much the run costs, so those are the budgets — and
 * the round cap is demoted to a backstop against pathological loops.
 *
 *   maxRounds     hard ceiling on model round trips. Generous; only trips on
 *                 a genuinely stuck model.
 *   maxToolCalls  total tool executions across the whole run.
 *   deadlineMs    wall clock. THIS is the real limit on the synchronous path,
 *                 because an iOS Shortcut gives up long before 12 rounds.
 *
 * The stepped path (api/step.js) overrides deadlineMs per invocation: each
 * invocation gets a fresh Vercel budget, so it only needs to fit ONE step,
 * and the run as a whole can be far longer than any single function.
 */
export function agentLimits(env = process.env, overrides = {}) {
  // `??` then an explicit finite check, NOT `||`. Zero is a legitimate budget
  // ("stop immediately"), and `Number(0) || 25000` would silently ignore it.
  const pick = (override, envValue, fallback) => {
    const raw = override ?? envValue;
    const n = Number(raw);
    return raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && n >= 0
      ? n
      : fallback;
  };

  return {
    maxRounds: pick(overrides.maxRounds, env.OSCAR_MAX_TOOL_ROUNDS, 12),
    maxToolCalls: pick(overrides.maxToolCalls, env.OSCAR_MAX_TOOL_CALLS, 40),
    deadlineMs: pick(overrides.deadlineMs, env.OSCAR_TOOL_DEADLINE_MS, 25000),
  };
}

/** Kept as a named export for anything still importing it. */
export const MAX_TOOL_ROUNDS = 12;

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
 * Build the state an agent run needs. Deliberately plain JSON: it gets written
 * to a database between steps on the async path, so nothing here may be a
 * function, a class or a Date.
 *
 * @param {{question, timeZone?, coords?, ip?, canWrite?, requireConfirm?, tools?, model?}} input
 */
export function createAgentState(input, env = process.env) {
  const question = tidy(input && input.question);
  if (!question) throw new AgentError('Missing question.', 400);
  if (question.length > 4000) throw new AgentError('Question is too long.', 413);

  const canWrite = input.canWrite === true;
  const maxWords = Number(env.OSCAR_MAX_WORDS) || DEFAULT_MAX_WORDS;
  const useTools = isToolsEnabled(env) && input.tools !== false;
  const availableCount = useTools ? availableTools({ canWrite }, env).length : 0;
  const timeZone = input.timeZone || env.OSCAR_TIMEZONE || 'UTC';

  return {
    question,
    model: input.model || env.OPENAI_MODEL || DEFAULT_MODEL,
    maxWords,
    canWrite,
    requireConfirm: input.requireConfirm,
    timeZone,
    coords: input.coords || null,
    ip: input.ip || null,
    useTools: useTools && availableCount > 0,

    messages: [
      {
        role: 'system',
        content: buildSystemPrompt({
          maxWords,
          persona: env.OSCAR_PERSONA,
          timeZone,
          tools: useTools && availableCount > 0,
          canWrite,
          requireConfirm: input.requireConfirm,
        }),
      },
      { role: 'user', content: question },
    ],

    round: 0,
    toolCalls: 0,
    toolsUsed: [],
    // signature -> times called, for loop detection
    seen: {},
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    events: [],
  };
}

function finish(state, { title, answer, detail, pendingConfirmation }) {
  return {
    title: clampWords(title, 8) || 'Oscar',
    answer: clampWords(answer, state.maxWords),
    detail: detail || '',
    model: state.model,
    usage: state.usage.total_tokens ? state.usage : null,
    toolsUsed: state.toolsUsed,
    rounds: state.round,
    events: state.events,
    ...(pendingConfirmation ? { pendingConfirmation } : {}),
  };
}

/**
 * Run exactly ONE round: one model call, plus any tools it asks for.
 *
 * Returns the new state and what happened, rather than looping internally.
 * That is the whole point — the caller decides whether to keep going, which is
 * what lets api/step.js spread a long run across many function invocations,
 * each with its own fresh execution budget.
 *
 * @returns {Promise<{state: object, status: 'working'|'done'|'confirm', result?: object}>}
 */
export async function runAgentStep(state, deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new AgentError('Server is missing OPENAI_API_KEY.', 500);

  const limits = agentLimits(env, deps.limits);
  const outOfTime = typeof deps.deadline === 'number' && Date.now() >= deps.deadline;
  const outOfRounds = state.round >= limits.maxRounds;
  const outOfCalls = state.toolCalls >= limits.maxToolCalls;

  // Withholding tools is what forces an answer — the model cannot call what it
  // was never offered, so this guarantees termination.
  const offerTools = state.useTools && !outOfTime && !outOfRounds && !outOfCalls;

  const messages = [...state.messages];
  if (!offerTools && state.useTools && state.round > 0) {
    messages.push({
      role: 'system',
      content:
        'You have no more tool calls available. Answer now using what you already found. ' +
        'If it is incomplete, say briefly what you could not determine.',
    });
  }

  const payload = await callOpenAI(
    {
      model: state.model,
      messages,
      ...(offerTools ? { tools: toolSchemas({ canWrite: state.canWrite }, env), tool_choice: 'auto' } : {}),
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 700,
    },
    { apiKey, doFetch, timeoutMs: deps.timeoutMs || 45000 }
  );

  const next = {
    ...state,
    round: state.round + 1,
    model: payload.model || state.model,
    usage: {
      prompt_tokens: state.usage.prompt_tokens + ((payload.usage && payload.usage.prompt_tokens) || 0),
      completion_tokens:
        state.usage.completion_tokens + ((payload.usage && payload.usage.completion_tokens) || 0),
      total_tokens: state.usage.total_tokens + ((payload.usage && payload.usage.total_tokens) || 0),
    },
  };

  const message = ((payload.choices && payload.choices[0]) || {}).message || {};
  const calls = message.tool_calls || [];

  // ---- the model answered ------------------------------------------------
  if (!calls.length) {
    const parsed = parseModelPayload(message.content);
    return {
      state: next,
      status: 'done',
      result: finish(next, { title: parsed.title, answer: parsed.answer, detail: parsed.detail }),
    };
  }

  // The assistant turn carrying the tool calls has to go back verbatim, or the
  // follow-up tool messages have nothing to attach to.
  next.messages = [...state.messages, message];

  const toolContext = {
    coords: state.coords,
    ip: state.ip,
    timeZone: state.timeZone,
    now: Date.now(),
    canWrite: state.canWrite,
    confirmed: deps.confirmed === true,
    requireConfirm: state.requireConfirm,
    env,
    fetchImpl: deps.toolFetchImpl || deps.fetchImpl || globalThis.fetch,
  };

  // Loop detection. Repeating a call after a write is legitimate — re-reading a
  // plan you just changed, say — so two identical calls are fine and only the
  // third is refused. That catches genuine loops without breaking real work.
  const seen = { ...state.seen };
  const results = await Promise.all(
    calls.map((call) => {
      const name = (call.function && call.function.name) || 'unknown';
      const args = (call.function && call.function.arguments) || '';
      const signature = `${name}:${args}`;
      const count = seen[signature] || 0;
      seen[signature] = count + 1;

      if (count >= 2) {
        return Promise.resolve({
          error:
            'You have already called this exact tool with these exact arguments twice. ' +
            'Use the result you already have, or try something different.',
        });
      }
      return runTool(name, args, toolContext);
    })
  );
  next.seen = seen;
  next.toolCalls = state.toolCalls + calls.length;

  // ---- something wants confirmation --------------------------------------
  const pending = results.find((r) => r && r.confirmation);
  if (pending) {
    const names = calls
      .filter((_, i) => results[i] && results[i].confirmation)
      .map((c) => c.function.name);
    next.toolsUsed = [...state.toolsUsed, ...names];
    return {
      state: next,
      status: 'confirm',
      result: finish(next, {
        title: 'Confirm',
        answer: pending.confirmation.prompt,
        detail: '',
        pendingConfirmation: pending.confirmation,
      }),
    };
  }

  // ---- feed the results back and keep going ------------------------------
  const names = [];
  const toolMessages = calls.map((call, i) => {
    const name = (call.function && call.function.name) || 'unknown';
    names.push(name);
    const outcome = results[i];
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(outcome.error ? { error: outcome.error } : outcome.result),
    };
  });

  next.toolsUsed = [...state.toolsUsed, ...names];
  next.messages = [...next.messages, ...toolMessages];
  // A readable trace for the web app to render as it works.
  next.events = [
    ...state.events,
    ...names.map((name, i) => ({
      round: next.round,
      tool: name,
      ok: !results[i].error,
      detail: results[i].error || undefined,
    })),
  ];

  return { state: next, status: 'working' };
}

/**
 * Ask the agent a question and wait for the answer.
 *
 * This is the synchronous path — what the Shortcut and the web console call.
 * It loops runAgentStep in-process under a wall-clock deadline, because the
 * caller is holding an HTTP connection open. For work that needs longer, see
 * the stepped path in api/step.js.
 *
 * @param {{question, timeZone?, coords?, ip?, canWrite?, requireConfirm?, tools?, model?}} input
 * @param {{env?, fetchImpl?, toolFetchImpl?, timeoutMs?, limits?}} [deps]
 */
export async function askAgent(input, deps = {}) {
  const env = deps.env || process.env;
  const limits = agentLimits(env, deps.limits);
  const started = Date.now();
  const deadline = started + limits.deadlineMs;

  let state = createAgentState({ ...input, model: input.model }, env);

  // The ceiling is maxRounds + 1: the extra pass is the forced answer that
  // happens once tools are withheld.
  for (let guard = 0; guard <= limits.maxRounds + 1; guard++) {
    const step = await runAgentStep(state, {
      ...deps,
      env,
      deadline,
      confirmed: input.confirmed === true,
    });
    state = step.state;

    if (step.status !== 'working') {
      return { ...step.result, elapsedMs: Date.now() - started };
    }
  }

  throw new AgentError('The agent kept calling tools without answering.', 500);
}
