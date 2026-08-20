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
import { runMissionStep, isMissionState, MAX_MISSION_STEPS } from '../lib/missions.js';
import { getSession } from '../lib/auth.js';
import { applyCors, readBody, send } from '../lib/http.js';
import { notifyAll } from '../lib/push.js';
import {
  loadJob,
  readJobToken,
  markRunning,
  saveProgress,
  markDone,
  markAwaitingConfirm,
  markAwaitingAnswer,
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

/**
 * Tell the phone the job is over.
 *
 * This is the whole reason background jobs are worth having: you ask for
 * something slow, put the phone away, and hear back when it is done. Awaited
 * rather than fired and forgotten, because a serverless function stops existing
 * the moment it responds — an un-awaited push would simply never be sent.
 *
 * notifyAll never throws and no-ops when push is unconfigured, so this stays a
 * single unguarded line at each call site.
 */
async function announce(job, { title, body, ttl, requireInteraction }) {
  const result = await notifyAll(
    {
      title,
      body: String(body || '').slice(0, 300),
      // Something that needs answering stays on screen until it is touched.
      requireInteraction: Boolean(requireInteraction),
      // One tag per job, so a job that finishes while an earlier notice about
      // it is still on screen replaces it rather than stacking.
      tag: `oscar-job-${job}`,
      url: '/',
      ttl,
    },
    {}
  );
  if (result && result.failed) {
    console.error(`[oscar] push for job ${job}: ${result.failed} failed`);
  }
}

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
    const parked = ['awaiting_confirm', 'awaiting_answer'];
    if (['done', 'failed', 'cancelled', ...parked].includes(job.status)) {
      return send(res, 200, { ok: true, status: job.status, finished: !parked.includes(job.status) });
    }
    if (!job.state) {
      await markFailed(jobId, 'The job has no saved state to resume from.');
      return send(res, 200, { ok: false, status: 'failed', error: 'No state to resume from.' });
    }

    if (job.status === 'queued') await markRunning(jobId);

    let state = job.state;
    let steps = job.steps || 0;
    const deadline = startedAt + INVOCATION_BUDGET_MS;

    // A mission plans and then works its own task list, so it gets a far
    // higher ceiling than a single conversation would ever need. Both are
    // still finite: past these numbers the run is stuck, not thorough.
    const mission = isMissionState(state);
    const ceiling = mission ? MAX_MISSION_STEPS : MAX_JOB_STEPS;

    // Keep going while there is comfortably enough time left to finish a round
    // AND still checkpoint afterwards.
    while (Date.now() < deadline - CHECKPOINT_HEADROOM_MS) {
      if (steps >= ceiling) {
        await markFailed(jobId, `Gave up after ${ceiling} steps without an answer.`);
        return send(res, 200, { ok: false, status: 'failed', steps });
      }

      const step = mission
        ? await runMissionStep(state, { env: process.env, deadline })
        : await runAgentStep(state, { env: process.env, deadline });
      state = step.state;
      steps += 1;

      if (step.status === 'done') {
        await markDone(jobId, step.result);
        await announce(jobId, {
          title: step.result.title || 'Oscar',
          body: step.result.answer,
        });
        return send(res, 200, { ok: true, status: 'done', steps, answer: step.result.answer });
      }

      if (step.status === 'question') {
        // The question row was written by the tool itself; this just records
        // which one the job is parked on, so the answer can find its way back.
        const asked = mission
          ? state.agent && state.agent.pendingQuestion
          : state.pendingQuestion;

        await markAwaitingAnswer(jobId, {
          state,
          result: step.result,
          questionId: asked && asked.id,
        });

        // The one notification that must not auto-dismiss: nothing else
        // happens until this is answered, so a missed one stalls the run
        // indefinitely.
        await announce(jobId, {
          title: 'Oscar has a question',
          body: step.result.answer,
          requireInteraction: true,
          // Held far longer than a status update — a question is still worth
          // delivering to a phone that has been off all afternoon.
          ttl: 24 * 60 * 60,
        });

        return send(res, 200, { ok: true, status: 'awaiting_answer', steps });
      }

      if (step.status === 'confirm') {
        await markAwaitingConfirm(jobId, { state, result: step.result });
        // A job stuck waiting on a yes/no is the case where a notification is
        // worth most — without one it simply sits there until you next look.
        await announce(jobId, {
          title: 'Oscar needs a yes or no',
          body: step.result.answer,
          requireInteraction: true,
        });
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
    if (jobId) {
      await markFailed(jobId, message).catch(() => {});
      // A job that died silently is indistinguishable from one still thinking,
      // which is the worst thing to leave someone holding a phone.
      await announce(jobId, { title: 'Oscar got stuck', body: message }).catch(() => {});
    }
    return send(res, 200, { ok: false, status: 'failed', error: message });
  }
}
