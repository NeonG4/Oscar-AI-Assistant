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
 *
 * TOOLS THAT ARE NOT IN THIS FILE
 *
 * ALL_TOOLS below is everything the project ships with. It is no longer
 * everything Oscar can hold: an MCP server you connect on the settings page
 * contributes tools too, and those arrive at runtime from the database rather
 * than from an import. See lib/mcp/ and MCP.md.
 *
 * They are kept in a separate list, refreshed by refreshRemoteTools(), and
 * merged in by everything below — so a caller asking "what tools are there"
 * gets both without having to know the difference. Two rules make that safe:
 *
 *   - A remote tool never inherits a built-in's privileges. It is in none of
 *     the sets below, so the Google, database and runner gates do not apply to
 *     it, and its `writes`/`confirm` flags come from the access level YOU set
 *     for it — never from anything the server claimed about itself.
 *   - A refresh that fails leaves the built-ins untouched. Extra tools are an
 *     addition; they can never subtract.
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
import { searchDriveTool, readDriveFileTool, trashDriveFileTool } from './drive.js';
import { createDocTool, readDocTool, appendToDocTool } from './docs.js';
import {
  createPlanTool,
  listPlansTool,
  getPlanTool,
  addPlanStepsTool,
  completePlanStepTool,
  updatePlanTool,
  deletePlanTool,
} from './plans.js';
import {
  rememberPersonTool,
  listPeopleTool,
  getPersonTool,
  forgetPersonTool,
} from './people.js';
import { runCommandTool, checkCommandTool } from './shell.js';
import { findUsernameTool, lookupProfileTool, lookupDomainTool } from './osint.js';
import { askUserTool } from './questions.js';
import { planTasksTool, finishTaskTool } from './checklist.js';
import { isGoogleConfigured } from '../google/auth.js';
import { isConfigured as isDatabaseConfigured } from '../db.js';
import { loadMcpTools } from '../mcp/tools.js';

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
  searchDriveTool,
  readDriveFileTool,
  trashDriveFileTool,
  createDocTool,
  readDocTool,
  appendToDocTool,
  createPlanTool,
  listPlansTool,
  getPlanTool,
  addPlanStepsTool,
  completePlanStepTool,
  updatePlanTool,
  deletePlanTool,
  rememberPersonTool,
  listPeopleTool,
  getPersonTool,
  forgetPersonTool,
  findUsernameTool,
  lookupProfileTool,
  lookupDomainTool,
  runCommandTool,
  checkCommandTool,
  askUserTool,
  planTasksTool,
  finishTaskTool,
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
  'search_drive',
  'read_drive_file',
  'trash_drive_file',
  'create_doc',
  'read_doc',
  'append_to_doc',
]);

/**
 * Tools that need Supabase.
 *
 * Unlike logging — which no-ops silently when unconfigured, because a missing
 * log line is not worth failing a request over — these are withheld entirely.
 * Accepting a plan and quietly dropping it would be much worse than saying
 * "I can't store plans".
 */
const DATABASE_TOOLS = new Set([
  'create_plan',
  'list_plans',
  'get_plan',
  'add_plan_steps',
  'complete_plan_step',
  'update_plan',
  'delete_plan',
  // Same reasoning as plans, and it applies to background catching too: with
  // nowhere to write a person, the honest thing is to have no people tools
  // rather than to accept a name and drop it.
  'remember_person',
  'list_people',
  'get_person',
  'forget_person',
  'run_cmd',
  'check_cmd',
  // A question that cannot be stored is a run that suspends with nothing to
  // wake it up. Better not to offer the tool at all.
  'ask_user',
]);

/**
 * Tools that need a runner paired to this deployment.
 *
 * Withheld entirely when OSCAR_RUNNER_SECRET is unset, because with no shared
 * secret there is no machine that could ever collect the command — offering the
 * model a tool whose every call would time out is worse than not having it.
 * Setting the secret is the deliberate act that says "I have a laptop for this".
 */
const RUNNER_TOOLS = new Set(['run_cmd', 'check_cmd']);

/**
 * Public-record lookups. Keyless, read-only, and off by nothing at all — the
 * same terms as the weather, because they need no account and change nothing.
 *
 * OSCAR_DISABLE_OSINT=1 withholds them anyway. They reach out to a dozen third
 * parties from your deployment's IP, and someone running this on a network
 * where that is unwelcome should be able to switch it off without editing code.
 */
const OSINT_TOOLS = new Set(['find_username', 'lookup_profile', 'lookup_domain']);

export function isOsintEnabled(env = process.env) {
  return env.OSCAR_DISABLE_OSINT !== '1';
}

export function isRunnerConfigured(env = process.env) {
  return Boolean((env.OSCAR_RUNNER_SECRET || '').trim());
}

const BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

/* ------------------------------------------------------------ remote tools */

/**
 * Tools from the MCP servers you have connected.
 *
 * Module-level and mutable, which is worth justifying because nothing else in
 * this file is. The alternative is threading an async load through
 * availableTools, toolSchemas, getTool and runTool — four synchronous
 * functions called from a dozen places — to deliver something that changes
 * about once a month. So instead the list is refreshed at the top of a request
 * by refreshRemoteTools(), and read synchronously after that, exactly like the
 * settings caches in lib/settings.js.
 *
 * The failure mode this shape buys is small and in the right direction: a
 * caller that forgets to refresh sees the built-in tools and nothing else.
 */
let REMOTE_TOOLS = [];
let REMOTE_BY_NAME = new Map();

/** Whether connected MCP servers are consulted at all. */
export function isMcpEnabled(env = process.env) {
  return env.OSCAR_DISABLE_MCP !== '1';
}

/**
 * Go and read what the connected servers offer, and hold onto it.
 *
 * Call this once before building a tool list — lib/agent.js does it at the top
 * of every step. Cheap on the second call: lib/mcp/servers.js caches the rows
 * for thirty seconds, so this is usually a rebuild of some closures.
 *
 * Never throws, and an unreadable server list means NO remote tools for this
 * step rather than an error — the same rule lib/db.js follows for logging. Note
 * which way that fails: a database having a bad afternoon costs you the extras
 * and leaves every built-in tool exactly where it was. The model may lose a
 * tool mid-conversation, which it handles the same way it handles one that
 * returned an error, and which is much the better direction for the failure of
 * a mechanism whose whole job is granting capability.
 */
export async function refreshRemoteTools(env = process.env, deps = {}) {
  if (!isMcpEnabled(env) || env.OSCAR_DISABLE_TOOLS === '1') {
    REMOTE_TOOLS = [];
    REMOTE_BY_NAME = new Map();
    return REMOTE_TOOLS;
  }

  try {
    const tools = await loadMcpTools({ ...deps, env });
    // A remote tool may not take a built-in's name. The built-in wins, always:
    // shadowing send_email from a server you connected last week is exactly the
    // trick this rule exists to stop, and prefixing makes a collision unlikely
    // rather than impossible.
    const safe = tools.filter((tool) => !BY_NAME.has(tool.name));
    REMOTE_TOOLS = safe;
    REMOTE_BY_NAME = new Map(safe.map((tool) => [tool.name, tool]));
  } catch (err) {
    console.error(`[oscar] could not load MCP tools: ${(err && err.message) || err}`);
  }

  return REMOTE_TOOLS;
}

/** What the last refresh found. Synchronous on purpose; see above. */
export function remoteTools() {
  return REMOTE_TOOLS;
}

/** Drop the remote tools. Used by the tests, and when MCP is switched off. */
export function clearRemoteTools() {
  REMOTE_TOOLS = [];
  REMOTE_BY_NAME = new Map();
}

export function getTool(name) {
  return BY_NAME.get(name) || REMOTE_BY_NAME.get(name) || null;
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
  const databaseReady = isDatabaseConfigured(env);
  const writesAllowed = env.OSCAR_ALLOW_WRITES === '1' && options.canWrite === true;

  // Remote tools go through the SAME write gate and nothing else. The named
  // sets above are about built-in dependencies — a Google token, a runner —
  // and a tool from a server you connected has none of them.
  const candidates = isMcpEnabled(env) ? [...ALL_TOOLS, ...REMOTE_TOOLS] : ALL_TOOLS;

  return candidates.filter((tool) => {
    if (!tool.remote) {
      if (GOOGLE_TOOLS.has(tool.name) && !googleReady) return false;
      if (DATABASE_TOOLS.has(tool.name) && !databaseReady) return false;
      if (RUNNER_TOOLS.has(tool.name) && !isRunnerConfigured(env)) return false;
      if (OSINT_TOOLS.has(tool.name) && !isOsintEnabled(env)) return false;
    }
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
  const tool = getTool(name);
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

    // ---- a tool that suspends the run -------------------------------------
    // `asks: true` means this tool's result is not an answer but a question,
    // and the round cannot be completed until a human supplies one. Lifted out
    // of `result` here so lib/agent.js can stop on it the same way it stops on
    // a confirmation, without knowing which tool did it.
    if (tool.asks && result && result.question) {
      return { question: result.question, elapsedMs: Date.now() - started };
    }

    // ---- a tool that edits the run's task list ----------------------------
    // Same idea as above: the tool describes what it wants done to the list,
    // and lib/agent.js — which owns the state — applies it. An error comes back
    // as an ordinary tool error, so a malformed list is something the model can
    // read and correct rather than a broken round.
    if (tool.tracks && result && !result.error && (result.taskList || result.taskDone)) {
      return {
        taskList: result.taskList,
        taskDone: result.taskDone,
        taskNote: result.note,
        elapsedMs: Date.now() - started,
      };
    }

    return { result, elapsedMs: Date.now() - started };
  } catch (err) {
    // Message only — a stack trace here is noise, and the tool's own error
    // messages are written to be readable.
    console.error(`[oscar] tool ${name} failed: ${(err && err.message) || err}`);
    return { error: (err && err.message) || 'That tool failed.' };
  }
}
