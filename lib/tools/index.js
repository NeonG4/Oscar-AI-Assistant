/**
 * lib/tools/index.js
 * ----------------------------------------------------------------------------
 * The tool registry, and the permission gate in front of it.
 *
 * Adding a tool is: write the file, export a definition with
 * { name, description, parameters, run }, import it here, add it to ALL_TOOLS.
 * Nothing in lib/agent.js needs to change.
 *
 * THE WRITE GATE
 *
 * A tool marked `writes: true` can change something in the real world — add a
 * calendar event, send mail. Those are withheld from the model entirely unless
 * the request proved write authority. Withheld, not refused: the model never
 * sees them in its tool list, so it can't be argued or tricked into trying.
 *
 * Write authority needs BOTH:
 *   1. OSCAR_ALLOW_WRITES=1 on the server — a master switch you control.
 *   2. The request itself proving it, by either
 *        a. a browser session (password + emailed code), or
 *        b. the x-oscar-write header matching OSCAR_WRITE_SECRET.
 *
 * That second condition is what makes a two-Shortcut setup worthwhile: a
 * read-only "Ask Oscar" shortcut carries only OSCAR_SHARED_SECRET, so even with
 * that key in hand nobody can send mail as you. See GOOGLE.md.
 */

import { locationTool } from './location.js';
import { weatherTool } from './weather.js';
import { listEventsTool, createEventTool, deleteEventTool } from './calendar.js';
import { listTasksTool, createTaskTool, completeTaskTool, deleteTaskTool } from './tasks.js';
import {
  searchEmailTool,
  readEmailTool,
  draftEmailTool,
  sendEmailTool,
  trashEmailTool,
} from './gmail.js';
import { isGoogleConfigured } from '../google/auth.js';

/** Every tool that exists. Availability is decided per request, below. */
export const ALL_TOOLS = [
  locationTool,
  weatherTool,
  listEventsTool,
  createEventTool,
  deleteEventTool,
  listTasksTool,
  createTaskTool,
  completeTaskTool,
  deleteTaskTool,
  searchEmailTool,
  readEmailTool,
  draftEmailTool,
  sendEmailTool,
  trashEmailTool,
];

/** Tools that need a working Google connection. */
const GOOGLE_TOOLS = new Set([
  'list_events',
  'create_event',
  'delete_event',
  'list_tasks',
  'create_task',
  'complete_task',
  'delete_task',
  'search_email',
  'read_email',
  'draft_email',
  'send_email',
  'trash_email',
]);

const BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name) {
  return BY_NAME.get(name) || null;
}

/**
 * Does this tool have to ask before acting?
 *
 * Deletes always do. Sending mail is opt-in via OSCAR_CONFIRM_SEND=1, because
 * it's irreversible too — but you already have draft_email for the unconfirmed
 * path, so forcing it on everyone would be more friction than it's worth.
 */
export function needsConfirmation(tool, env = process.env) {
  if (!tool) return false;
  if (tool.confirm) return true;
  if (tool.name === 'send_email' && env.OSCAR_CONFIRM_SEND === '1') return true;
  return false;
}

/**
 * Which tools this particular request may use.
 *
 * @param {{canWrite?: boolean}} [options]
 */
export function availableTools(options = {}, env = process.env) {
  if (env.OSCAR_DISABLE_TOOLS === '1') return [];

  const googleReady = isGoogleConfigured(env);
  const writesAllowed = env.OSCAR_ALLOW_WRITES === '1' && options.canWrite === true;

  return ALL_TOOLS.filter((tool) => {
    if (GOOGLE_TOOLS.has(tool.name) && !googleReady) return false;
    if (tool.writes && !writesAllowed) return false;
    return true;
  });
}

/** The `tools` array as the OpenAI chat completions API wants it. */
export function toolSchemas(options = {}, env = process.env) {
  return availableTools(options, env).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function isToolsEnabled(env = process.env) {
  return env.OSCAR_DISABLE_TOOLS !== '1';
}

/**
 * Execute one tool call.
 *
 * Never throws. A tool that fails returns `{ error }`, which goes back to the
 * model as the tool result — so the model can say "I couldn't reach your
 * calendar" in its own words instead of the whole request collapsing. That is
 * the single most important property of this function: a broken tool degrades
 * the answer, it doesn't destroy it.
 *
 * @param {string} name
 * @param {string|object} rawArgs  JSON string from the model, or an object
 * @param {object} ctx             { coords, ip, timeZone, env, fetchImpl, canWrite }
 */
export async function runTool(name, rawArgs, ctx = {}) {
  const env = ctx.env || process.env;
  const tool = BY_NAME.get(name);
  if (!tool) return { error: `There is no tool called ${name}.` };

  // Belt and braces. The model should never see a withheld tool, but if a
  // schema list is ever stale or cached, the gate still holds here.
  const permitted = availableTools({ canWrite: ctx.canWrite }, env).some((t) => t.name === name);
  if (!permitted) {
    return {
      error: tool.writes
        ? 'That action needs write permission, which this request does not have.'
        : 'That tool is not available right now.',
    };
  }

  let args = {};
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return { error: 'The arguments for that tool were not valid JSON.' };
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs;
  }

  // ---- confirmation gate ------------------------------------------------
  // A tool marked `confirm: true` describes what it WOULD do instead of acting,
  // so the caller can approve it. Nothing destructive happens until
  // /api/confirm replays the call with confirmed:true and a valid signed token.
  //
  // WHETHER TO ASK IS THE CALLER'S DECISION, not this function's. Speech is
  // where things go wrong — "delete the event on Thursday" can be misheard, and
  // there's no screen showing you what matched. Typing on the web console is
  // deliberate, and the answer is right there to read. So api/ask.js asks for
  // confirmation on the Shortcut (and on browser dictation) but not on typed
  // web input. See requireConfirmation() there.
  //
  // Defaults to asking: a caller that forgets to set the flag gets the safe
  // behaviour, not the destructive one.
  if (needsConfirmation(tool, env) && ctx.requireConfirm !== false && ctx.confirmed !== true) {
    try {
      const prompt = tool.describe
        ? await tool.describe(args, ctx)
        : `Go ahead with ${tool.name}?`;
      return { confirmation: { tool: name, args, prompt } };
    } catch (err) {
      // If we can't even look up the target, say so rather than asking the user
      // to confirm something we can't name.
      return { error: (err && err.message) || 'Could not find what you asked me to change.' };
    }
  }

  try {
    const started = Date.now();
    const result = await tool.run(args, ctx);
    return { result, elapsedMs: Date.now() - started };
  } catch (err) {
    // Message only — a stack trace here is noise, and the tool's own error
    // messages are written to be readable.
    console.error(`[oscar] tool ${name} failed: ${(err && err.message) || err}`);
    return { error: (err && err.message) || 'That tool failed.' };
  }
}
