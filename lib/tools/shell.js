/**
 * lib/tools/shell.js
 * ----------------------------------------------------------------------------
 * Running a command on your own computer.
 *
 *   "run npm test on my laptop"
 *      -> queued, the runner picks it up, output comes back in the answer
 *
 * HOW THIS ACTUALLY REACHES THE LAPTOP
 *
 * It doesn't, directly. This tool writes a row to `commands` and then waits a
 * few seconds watching for the result. Meanwhile scripts/runner.js — running on
 * the laptop — is polling /api/runner, claims the row, executes it, and posts
 * the output back. See lib/commands.js for why the direction is inverted.
 *
 * WHAT THIS TOOL IS AND IS NOT
 *
 * It is a request. The runner on the laptop enforces lib/shell-policy.js and
 * refuses anything it doesn't like, which is why the check below is described
 * as a courtesy rather than a control: it exists so the model gets a fast,
 * readable "no" instead of waiting for a round trip to find out. Deleting the
 * check would not make anything more permissive. Deleting the runner's check
 * would make everything permissive, which is the asymmetry to remember.
 *
 * THREE GATES STAND IN FRONT OF IT
 *
 *   1. `writes: true`  — the read-only "Ask Oscar" Shortcut never sees this
 *                        tool at all, so the weakest key in the system cannot
 *                        run code on your machine.
 *   2. `confirm: true` — a dictated command is read back before it runs.
 *                        Speech is exactly where "delete the old branch" turns
 *                        into something else; see the note in tools/index.js.
 *   3. the runner      — the allowlist, on the laptop, with the final say.
 */

import {
  queueCommand,
  getCommand,
  isSettled,
  clampTimeout,
  DEFAULT_TIMEOUT_MS,
} from '../commands.js';
import { checkCommand } from '../shell-policy.js';
import { getCommandPolicy } from '../settings.js';

/** How long the tool waits for output before handing back a "still going". */
const WAIT_MS = 20000;
const POLL_EVERY_MS = 900;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Trim output to something a model can read without burning the context. */
function forModel(text, limit = 4000) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return undefined;
  return s.length <= limit ? s : `${s.slice(0, limit)}\n... [truncated]`;
}

function describeOutcome(cmd) {
  const base = {
    id: cmd.id,
    command: cmd.command,
    status: cmd.status,
    exitCode: cmd.exitCode,
    stdout: forModel(cmd.stdout),
    stderr: forModel(cmd.stderr),
  };

  if (cmd.status === 'done') {
    return {
      ...base,
      ok: cmd.exitCode === 0,
      confirmation:
        cmd.exitCode === 0
          ? 'The command finished successfully.'
          : `The command exited with code ${cmd.exitCode}.`,
    };
  }
  if (cmd.status === 'refused') {
    return { ...base, ok: false, error: cmd.error || 'Your computer refused to run that.' };
  }
  if (cmd.status === 'expired') {
    return {
      ...base,
      ok: false,
      error:
        'Nothing collected that command. The runner does not appear to be going on your ' +
        'computer — start it with `npm run runner`.',
    };
  }
  return { ...base, ok: false, error: cmd.error || 'The command failed.' };
}

export const runCommandTool = {
  name: 'run_cmd',
  description:
    "Run a shell command on the user's own computer and get its output back. Use for anything " +
    'that has to touch their machine: running tests, checking git status, listing or reading ' +
    'files in a local repo, running a script you have written. The command runs in a real shell ' +
    'on their laptop, so prefer one self-contained command per call and read the output before ' +
    'deciding what to do next. The machine enforces its own allowlist and may refuse — if it ' +
    'does, say so plainly rather than trying to work around it. Not for anything on the web, and ' +
    'not for reading the user\'s Drive or email, which have their own tools.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact command line to run, e.g. "git status" or "npm test".',
      },
      cwd: {
        type: 'string',
        description:
          'Optional directory to run in, absolute or relative to the runner\'s root. ' +
          'Leave empty for the runner\'s default directory.',
      },
      reason: {
        type: 'string',
        description: 'One short phrase on why you are running this, shown to the user.',
      },
      timeout_ms: {
        type: 'number',
        description: `How long to allow before killing it. Default ${DEFAULT_TIMEOUT_MS}, max 600000.`,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },

  writes: true,
  confirm: true,

  /** Read-only. Shows the exact command, because that is the thing being approved. */
  async describe(args = {}) {
    const command = String(args.command || '').trim();
    const where = args.cwd ? ` in ${args.cwd}` : '';
    return `Run this on your computer${where}?\n\n${command}`;
  },

  async run(args = {}, ctx = {}) {
    const command = String(args.command || '').trim();
    if (!command) return { error: 'No command was given.' };

    // The off switch, checked before anything is queued. Withholding the
    // tool from the model is the main enforcement; this is here because the
    // tool list is built synchronously from env and this setting lives in
    // the database, so a model mid-conversation can still be holding it.
    if ((await getCommandPolicy(ctx)) === 'off') {
      return {
        error:
          'Running commands is switched off in your settings, so I cannot use your ' +
          'computer. You can turn it back on from the website.',
      };
    }

    // A courtesy check so the model hears "no" immediately. The runner repeats
    // this on the laptop and its answer is the one that counts.
    const verdict = checkCommand(command, { mode: 'unrestricted' });
    if (!verdict.ok) return { error: verdict.reason };

    const queued = await queueCommand(
      {
        command,
        cwd: args.cwd,
        reason: args.reason,
        timeoutMs: clampTimeout(args.timeout_ms),
        jobId: ctx.jobId,
        via: ctx.via,
      },
      ctx
    );

    // Wait for the runner, but never longer than the agent step can afford.
    const deadline = Math.min(
      Date.now() + WAIT_MS,
      ctx.deadline ? ctx.deadline - 3000 : Number.POSITIVE_INFINITY
    );

    let latest = queued;
    while (Date.now() < deadline) {
      await sleep(POLL_EVERY_MS);
      latest = await getCommand(queued.id, ctx);
      if (isSettled(latest.status)) return describeOutcome(latest);
    }

    return {
      id: queued.id,
      command,
      status: latest.status,
      ok: false,
      pending: true,
      note:
        latest.status === 'queued'
          ? 'Still waiting for the computer to pick this up. It may be asleep, or the runner ' +
            'may not be started. Use check_cmd with this id to look again.'
          : 'Still running. Use check_cmd with this id to collect the output.',
    };
  },
};

export const checkCommandTool = {
  name: 'check_cmd',
  description:
    'Look up a command you previously started with run_cmd, by its id. Use when run_cmd came ' +
    'back still running or still queued, to collect the output once it has finished.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id run_cmd returned.' },
    },
    required: ['id'],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const cmd = await getCommand(String(args.id || '').trim(), ctx);
    if (!isSettled(cmd.status)) {
      return { id: cmd.id, command: cmd.command, status: cmd.status, pending: true };
    }
    return describeOutcome(cmd);
  },
};
