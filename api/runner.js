/**
 * api/runner.js
 * ----------------------------------------------------------------------------
 * The only door between Oscar and your computer.
 *
 *   POST /api/runner  { action: 'claim',  runner }        -> the next command, or null
 *   POST /api/runner  { action: 'result', id, exitCode, stdout, stderr }
 *
 * Your laptop calls this; this never calls your laptop. See lib/commands.js for
 * why the direction is inverted, and lib/shell-policy.js for what the laptop
 * does with a command once it has one.
 *
 * AUTH IS ITS OWN SECRET, DELIBERATELY
 *
 * `x-oscar-runner` must match OSCAR_RUNNER_SECRET — not the Shortcut key, not
 * the write key, not a session. Three reasons. The Shortcut key lives on a
 * phone that could be lost, and it should never be able to drain the command
 * queue. A session belongs to a browser, and browsers are where XSS happens.
 * And a separate secret can be rotated on its own: if the laptop is stolen you
 * change this one value and the machine is cut off without disturbing anything
 * else you use every day.
 *
 * WHAT THIS ENDPOINT DOES NOT DO
 *
 * It does not decide whether a command is safe. It hands over whatever was
 * queued and records whatever came back. The judgement lives on the laptop, on
 * purpose — a check here would be a check an attacker who reached this
 * deployment could simply edit.
 */

import { applyCors, readBody, send } from '../lib/http.js';
import { safeEqual, penaltyDelay } from '../lib/auth.js';
import {
  claimNext,
  settleCommand,
  getCommand,
  isCommandsConfigured,
  CommandError,
} from '../lib/commands.js';

function runnerSecret(env = process.env) {
  return (env.OSCAR_RUNNER_SECRET || '').trim();
}

/** Constant-time, and a deliberate pause on failure so this can't be probed quickly. */
async function authorised(req, env = process.env) {
  const secret = runnerSecret(env);
  if (!secret) return false;

  const offered = String(req.headers['x-oscar-runner'] || '').trim();
  if (!offered) return false;

  if (!safeEqual(offered, secret)) {
    await penaltyDelay();
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });

  if (!runnerSecret()) {
    return send(res, 503, {
      ok: false,
      error: 'No runner is configured. Set OSCAR_RUNNER_SECRET and redeploy.',
    });
  }
  if (!isCommandsConfigured()) {
    return send(res, 503, {
      ok: false,
      error: 'No database is configured, so there is no command queue.',
    });
  }
  if (!(await authorised(req))) {
    return send(res, 401, { ok: false, error: 'Not authorised.' });
  }

  try {
    const body = await readBody(req);
    const action = String(body.action || 'claim');

    if (action === 'claim') {
      const command = await claimNext({ runner: body.runner }, {});
      return send(res, 200, { ok: true, command: command || null });
    }

    if (action === 'result') {
      const id = String(body.id || '').trim();
      if (!id) return send(res, 400, { ok: false, error: 'No command id.' });

      // Confirms the row exists, and gives a 404 rather than a silent no-op
      // when a runner reports on something that was already expired away.
      await getCommand(id, {});

      const status = ['done', 'failed', 'refused'].includes(body.status) ? body.status : 'done';
      await settleCommand(
        id,
        {
          status,
          exitCode: body.exitCode === undefined ? null : Number(body.exitCode),
          stdout: body.stdout || '',
          stderr: body.stderr || '',
          error: body.error,
        },
        {}
      );
      return send(res, 200, { ok: true, id, status });
    }

    return send(res, 400, { ok: false, error: `Unknown action "${action}".` });
  } catch (err) {
    const status = err instanceof CommandError ? err.status : 500;
    const message = err instanceof CommandError ? err.message : 'The runner request failed.';
    console.error('[oscar] runner:', err);
    return send(res, status, { ok: false, error: message });
  }
}
