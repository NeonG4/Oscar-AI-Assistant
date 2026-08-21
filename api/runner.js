/**
 * api/runner.js
 * ----------------------------------------------------------------------------
 * The only door between Oscar and your computer.
 *
 *   POST /api/runner  { action: 'claim',  runner }        -> the next command, or null
 *   POST /api/runner  { action: 'result', id, exitCode, stdout, stderr }
 *   POST /api/runner  { action: 'confirm', id, why }     -> asks you, returns questionId
 *   POST /api/runner  { action: 'confirm-status', questionId }
 *
 * The last two are the confirmation gate. The laptop decides a command needs
 * your approval and uses them to have you asked; this endpoint carries the
 * question out and the answer back, and judges neither.
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
import { createQuestion, getQuestion, QuestionError } from '../lib/questions.js';
import { notifyAll } from '../lib/push.js';
import { getCommandPolicy } from '../lib/settings.js';

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
      // The policy rides along on every claim so the laptop always has a
      // fresh copy without a second round trip. The runner decides what to
      // do with it; this end only reports it — and refuses to hand out work
      // when the answer is off, so the switch holds even against a runner
      // that ignores it.
      const policy = await getCommandPolicy({});
      if (policy === 'off') {
        return send(res, 200, { ok: true, command: null, policy });
      }

      const command = await claimNext({ runner: body.runner }, {});
      return send(res, 200, { ok: true, command: command || null, policy });
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

    /**
     * The laptop has decided a command needs your say-so.
     *
     * Note the direction: the runner is telling the server to ask, not asking
     * the server for permission. The verdict was reached on the laptop by
     * lib/shell-policy.js and is not revisited here — this endpoint only
     * carries the question to a device you are holding and carries the answer
     * back. A compromised deployment can therefore refuse to ask (the command
     * simply never runs) but cannot manufacture a yes it was not given.
     */
    if (action === 'confirm') {
      const id = String(body.id || '').trim();
      if (!id) return send(res, 400, { ok: false, error: 'No command id.' });

      const command = await getCommand(id, {});

      const question = await createQuestion(
        {
          question: `Run this on ${body.runner || 'your computer'}?\n\n${command.command}`,
          // Two options, safest first, so the thumb rests on "no".
          options: ['No, cancel it', 'Yes, run it'],
          context: body.why ? `Flagged because it ${body.why}.` : undefined,
        },
        {}
      );

      // Awaited, not fired and forgotten: a serverless function stops existing
      // the moment it responds, and an un-awaited push would never be sent.
      const pushed = await notifyAll(
        {
          title: 'Oscar needs permission',
          body: String(command.command).slice(0, 200),
          // It is a question. It stays on screen until it is dealt with.
          requireInteraction: true,
          tag: `oscar-confirm-${id}`,
          url: '/',
        },
        {}
      );

      return send(res, 200, {
        ok: true,
        questionId: question.id,
        // The runner prints this. A gate nobody can see is worse than no gate:
        // if push is unconfigured the command would otherwise sit there
        // silently until it timed out, looking like a hang.
        delivered: Boolean(pushed && pushed.sent),
      });
    }

    /**
     * Has it been answered yet? Polled by the runner while it waits.
     *
     * The answer is matched here rather than on the laptop only so that the
     * runner stays dumb about wording; the laptop still makes the final call on
     * whether to run, and treats anything that is not an explicit yes as a no.
     */
    if (action === 'confirm-status') {
      const questionId = String(body.questionId || '').trim();
      if (!questionId) return send(res, 400, { ok: false, error: 'No question id.' });

      const question = await getQuestion(questionId, {});
      const answered = question.status === 'answered';

      return send(res, 200, {
        ok: true,
        status: question.status,
        answered,
        approved: answered ? /^\s*y/i.test(String(question.answer || '')) : false,
        answer: question.answer,
      });
    }

    return send(res, 400, { ok: false, error: `Unknown action "${action}".` });
  } catch (err) {
    const known = err instanceof CommandError || err instanceof QuestionError;
    const status = known ? err.status : 500;
    const message = known ? err.message : 'The runner request failed.';
    console.error('[oscar] runner:', err);
    return send(res, status, { ok: false, error: message });
  }
}
