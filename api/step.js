/**
 * api/step.js
 * ----------------------------------------------------------------------------
 * Advances one job as far as this invocation's budget allows, then hands off.
 *
 *   POST /api/step  { jobId, token }
 *
 * This is the endpoint that removes the 60-second ceiling. Each call gets a
 * fresh Vercel execution budget, so a run that needs five minutes simply spans
 * several calls, with lib/jobs.js carrying the state between them.
 *
 * WHO CALLS IT
 *
 *   - The previous invocation, just before it runs out (fire and forget).
 *   - The web app, while you are watching it work.
 *
 * Either alone is sufficient. Both together means progress continues whether
 * the app is open or not, and a dropped hop is recovered rather than fatal.
 *
 * AUTH: a `token` signed for this specific job id, or a normal browser session.
 * Not the Shortcut key — this endpoint spends OpenAI credit in a loop, so the
 * weakest credential in the system should not be able to drive it.
 */

import { runAgentStep, AgentError } from '../lib/agent.js';
import { getSession } from '../lib/auth.js';
import { applyCors, readBody, send } from '../lib/http.js';
import {
  loadJob,
  readJobToken,
  markRunning,
  saveProgress,
  markDone,
  markAwaitingConfirm,
  markFailed,
  continueJob,
  MAX_JOB_STEPS,
  JobError,
} from '../lib/jobs.js';

/**
 * Stop well short of the function's own limit so there is room to write the
 * checkpoint and fire the next hop. Losing the state because we ran the loop
 * right up to the wall would be the worst possible failure here.
 */
const INVOCATION_BUDGET_MS = Number(process.env.OSCAR_STEP_BUDGET_MS) || 40000;
const CHECKPOINT_HEADROOM_MS = 8000;

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });

  const startedAt = Date.now();
  let jobId = null;

  try {
    const body = await readBody(req);
    jobId = body.jobId || body.id;
    if (!jobId) return send(res, 400, { ok: false, error: 'No jobId.' });

    const authorised = readJobToken(body.token, process.env) === String(jobId) || Boolean(getSession(req));
    if (!authorised) return send(res, 401, { ok: false, error: 'Not authorised to advance this job.' });

    const job = await loadJob(jobId);

    // Terminal, or waiting on a human. Either way there is nothing to do, and
    // saying so plainly stops a caller from retrying in a loop.
    if (['done', 'failed', 'cancelled', 'awaiting_confirm'].includes(job.status)) {
      return send(res, 200, { ok: true, status: job.status, finished: job.status !== 'awaiting_confirm' });
    }
    if (!job.state) {
      await markFailed(jobId, 'The job has no saved state to resume from.');
      return send(res, 200, { ok: false, status: 'failed', error: 'No state to resume from.' });
    }

    if (job.status === 'queued') await markRunning(jobId);

    let state = job.state;
    let steps = job.steps || 0;
    const deadline = startedAt + INVOCATION_BUDGET_MS;

    // Keep going while there is comfortably enough time left to finish a round
    // AND still checkpoint afterwards.
    while (Date.now() < deadline - CHECKPOINT_HEADROOM_MS) {
      if (steps >= MAX_JOB_STEPS) {
        await markFailed(jobId, `Gave up after ${MAX_JOB_STEPS} steps without an answer.`);
        return send(res, 200, { ok: false, status: 'failed', steps });
      }

      const step = await runAgentStep(state, { env: process.env, deadline });
      state = step.state;
      steps += 1;

      if (step.status === 'done') {
        await markDone(jobId, step.result);
        return send(res, 200, { ok: true, status: 'done', steps, answer: step.result.answer });
      }

      if (step.status === 'confirm') {
        await markAwaitingConfirm(jobId, { state, result: step.result });
        return send(res, 200, { ok: true, status: 'awaiting_confirm', steps });
      }
    }

    // Out of budget for THIS invocation, not for the job. Checkpoint and pass
    // the baton to a fresh one.
    await saveProgress(jobId, { state, events: state.events || [], steps });
    const handedOff = continueJob(jobId);

    return send(res, 200, {
      ok: true,
      status: 'running',
      steps,
      continued: handedOff,
      // When self-continuation is unavailable (local dev), the client must
      // drive the next step itself.
      note: handedOff ? undefined : 'Call /api/step again to continue.',
    });
  } catch (err) {
    const message =
      err instanceof AgentError || err instanceof JobError
        ? err.message
        : 'Something broke while running the job.';
    console.error('[oscar] step:', err);
    if (jobId) await markFailed(jobId, message).catch(() => {});
    return send(res, 200, { ok: false, status: 'failed', error: message });
  }
}
