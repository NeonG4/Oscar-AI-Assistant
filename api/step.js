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
import {
  runMissionStep,
  isMissionState,
  missionSummary,
  closeMissionPlan,
  MAX_MISSION_STEPS,
} from '../lib/missions.js';
import { getSession } from '../lib/auth.js';
import { applyCors, readBody, send } from '../lib/http.js';
import { notifyAll } from '../lib/push.js';
import { logConversation, conversationRow } from '../lib/db.js';
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
 * How much of the function's own limit one invocation spends on rounds.
 *
 * vercel.json gives these functions 60 seconds. Time not spent here is not
 * saved, it is paid again: every handoff costs a response, a cold start and a
 * reload of the state, so a budget of 40s rather than 55s meant roughly a third
 * more invocations for the same work.
 */
const INVOCATION_BUDGET_MS = Number(process.env.OSCAR_STEP_BUDGET_MS) || 55000;

/**
 * Held back from that budget for the checkpoint write and the handoff. Losing
 * the state because we ran the loop right up to the wall would be the worst
 * possible failure here.
 */
const CHECKPOINT_HEADROOM_MS = 8000;

/**
 * Never START a round without at least this much runway left.
 *
 * A round the platform kills half way through is worse than one that never
 * began: the invocation dies before it can either checkpoint or hand off, and
 * the job stops dead with nothing left to restart it.
 */
const MIN_ROUND_RUNWAY_MS = 12000;

/**
 * How many times a job may hand a round on because the provider pushed back.
 *
 * lib/backoff.js already waits as long as ONE invocation can afford. When that
 * is not enough, the round is worth passing to a fresh invocation with a fresh
 * budget rather than failing a job that may be twenty steps deep. Bounded,
 * because a provider that is properly down stays down, and an unbounded version
 * of this is a job that hops forever. Reset the moment a round succeeds, so a
 * long mission is not killed by five unlucky minutes spread over an hour.
 */
const MAX_STALLED_HANDOFFS = 5;

// Exported for the test that checks these three still fit inside the
// maxDuration vercel.json hands the function. Nothing else reads them.
export {
  INVOCATION_BUDGET_MS as STEP_BUDGET_MS,
  CHECKPOINT_HEADROOM_MS as STEP_HEADROOM_MS,
  MIN_ROUND_RUNWAY_MS as STEP_MIN_ROUND_RUNWAY_MS,
};

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

/**
 * Write the finished job into the conversation log.
 *
 * Without this, background work is invisible in History — you would see every
 * quick question you ever asked and none of the long ones, which is exactly
 * backwards. It also carries the job's `conversation_id`, so an answer that
 * took four minutes still lands in the thread it was asked in and a follow-up
 * can refer back to it.
 *
 * Logged when the job reaches a terminal state and only then: a job that is
 * still running has no answer to record, and one row per job is what keeps
 * History a list of exchanges rather than a list of steps.
 */
async function logTurn(job, { result, error, status }) {
  const startedAt = job.created_at ? Date.parse(job.created_at) : NaN;

  await logConversation(
    conversationRow({
      question: job.question,
      conversationId: job.conversation_id,
      result,
      error,
      status: status || (error ? 500 : 200),
      via: job.via,
      source: job.source,
      totalMs: Number.isFinite(startedAt) ? Date.now() - startedAt : null,
    })
  ).catch(() => {});
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
  let job = null;
  // Hoisted out of the loop so the failure path below can still see how far the
  // run got. Reporting a plain failure over work that actually happened is the
  // one thing worse than the failure itself.
  let state = null;

  try {
    const body = await readBody(req);
    jobId = body.jobId || body.id;
    if (!jobId) return send(res, 400, { ok: false, error: 'No jobId.' });

    const authorised = readJobToken(body.token, process.env) === String(jobId) || Boolean(getSession(req));
    if (!authorised) return send(res, 401, { ok: false, error: 'Not authorised to advance this job.' });

    try {
      job = await loadJob(jobId);
    } catch (err) {
      // Removed from the Jobs tab while it was still going. Nothing to advance,
      // nothing to mark failed, and nobody to tell — the row that would have
      // recorded any of that is precisely the thing that was deleted.
      if (err instanceof JobError && err.status === 404) {
        return send(res, 200, { ok: true, status: 'gone', finished: true });
      }
      throw err;
    }

    // Terminal, or waiting on a human. Either way there is nothing to do, and
    // saying so plainly stops a caller from retrying in a loop.
    const parked = ['awaiting_confirm', 'awaiting_answer'];
    if (['done', 'incomplete', 'failed', 'cancelled', ...parked].includes(job.status)) {
      return send(res, 200, { ok: true, status: job.status, finished: !parked.includes(job.status) });
    }
    if (!job.state) {
      await markFailed(jobId, 'The job has no saved state to resume from.');
      return send(res, 200, { ok: false, status: 'failed', error: 'No state to resume from.' });
    }

    // Touched at the START of every invocation, not just the first. It is what
    // makes a quiet job distinguishable from a dead one: with this, the row can
    // never go longer than a single round without moving, so the app can treat
    // a longer silence than that as a dropped handoff and restart the job
    // itself. Without it, two slow rounds in a row look exactly like a job
    // whose baton was lost.
    await markRunning(jobId);

    state = job.state;
    let steps = job.steps || 0;
    let stalls = Number(state.stalls) || 0;
    const deadline = startedAt + INVOCATION_BUDGET_MS;

    // A mission plans and then works its own task list, so it gets a far
    // higher ceiling than a single conversation would ever need. Both are
    // still finite: past these numbers the run is stuck, not thorough.
    const mission = isMissionState(state);
    const ceiling = mission ? MAX_MISSION_STEPS : MAX_JOB_STEPS;

    // Keep going while there is comfortably enough time left to start a round,
    // finish it, AND still checkpoint afterwards.
    while (Date.now() < deadline - CHECKPOINT_HEADROOM_MS - MIN_ROUND_RUNWAY_MS) {
      if (steps >= ceiling) {
        const gaveUp = `Gave up after ${ceiling} steps without an answer.`;
        await markFailed(jobId, gaveUp);
        await logTurn(job, { error: gaveUp });
        return send(res, 200, { ok: false, status: 'failed', steps });
      }

      // The model call gets whatever is left of this invocation, less the
      // headroom. Without a timeout of its own it runs on lib/agent.js's flat
      // 45-second clock, which can comfortably outlive the function holding it.
      const timeoutMs = deadline - CHECKPOINT_HEADROOM_MS - Date.now();

      let step;
      try {
        step = mission
          ? await runMissionStep(state, { env: process.env, deadline, timeoutMs })
          : await runAgentStep(state, { env: process.env, deadline, timeoutMs });
      } catch (err) {
        // The provider was busy, slow or briefly broken — not a request that
        // was wrong and will be wrong again. `state` is still what it was
        // before the round and no tool has run yet at that point, so the round
        // can simply happen again. A 429 that means "no quota left" is excluded
        // by hand: it is the one that will say the same thing in an hour.
        const retryable =
          err instanceof AgentError &&
          err.permanent !== true &&
          (err.status === 504 || err.status === 502 || err.status === 429);

        // Cut short because THIS invocation was running out. Fall out of the
        // loop and let the ordinary handoff below carry the round on.
        if (retryable && Date.now() >= deadline - CHECKPOINT_HEADROOM_MS) break;

        // Same round, different reason: lib/backoff.js waited as long as this
        // invocation could afford and the provider still said no. Failing here
        // would throw away a mission that may be twenty steps deep over a few
        // busy minutes, so the round is handed to a fresh invocation instead.
        // Bounded by MAX_STALLED_HANDOFFS so a provider that is genuinely down
        // ends the job rather than being retried forever.
        if (retryable && stalls < MAX_STALLED_HANDOFFS) {
          stalls += 1;
          console.error(`[oscar] job ${jobId} stalled (${err.message}) — handoff ${stalls}`);
          state = { ...state, stalls };
          await saveProgress(jobId, {
            state,
            events: state.events || [],
            tasks: state.tasks || [],
            steps,
          });
          const passed = await continueJob(jobId);
          return send(res, 200, {
            ok: true,
            status: 'running',
            steps,
            continued: passed,
            stalled: err.message,
          });
        }

        throw err;
      }

      state = step.state;
      steps += 1;
      // The round landed, so whatever the provider was doing earlier is over.
      if (stalls || state.stalls) {
        stalls = 0;
        state = { ...state, stalls: 0 };
      }

      if (step.status === 'done') {
        // 'done' is the agent's word for "this round produced an answer", which
        // is not the same as the work being finished. markDone knows the
        // difference; so must everything reported from here.
        const finished = step.result.incomplete ? 'incomplete' : 'done';

        await markDone(jobId, step.result);
        await logTurn(job, { result: step.result });
        await announce(jobId, {
          // A notification saying "Here's your summary" over a half-done task
          // list is exactly the lie this is here to stop.
          title: step.result.incomplete ? 'Stopped early' : step.result.title || 'Oscar',
          body: step.result.answer,
        });
        return send(res, 200, { ok: true, status: finished, steps, answer: step.result.answer });
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

      // Checkpoint after every round, not only when the invocation runs out.
      // Two things depend on it: the progress panel, which would otherwise sit
      // frozen for the length of a whole invocation and make a working job look
      // like a hung one, and recovery — a round that has been written down
      // never has to be paid for twice.
      //
      // `tasks` is written on the job itself so the Jobs tab can show progress
      // without loading the whole state blob, and so it survives the state
      // being dropped when the job finishes.
      await saveProgress(jobId, {
        state,
        events: state.events || [],
        tasks: state.tasks || [],
        steps,
      });
    }

    // Out of budget for THIS invocation, not for the job. The loop above has
    // already checkpointed, so all that is left is to pass the baton on.
    const handedOff = await continueJob(jobId);

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
      // A mission that got real work done is not a failure, whatever broke at
      // the end of it. The document it wrote is sitting in Drive either way,
      // and the run most likely to be cut short is the wrap-up — the last one,
      // after an hour of hammering the provider, whose only job was to describe
      // things that already exist. So the mission reports itself from its own
      // notes and artifacts instead, honestly marked as stopped early when it
      // did not finish the list.
      const salvaged =
        isMissionState(state) && (state.tasksDone > 0 || (state.artifacts || []).length > 0)
          ? missionSummary(state, { error: message })
          : null;

      if (salvaged) {
        await markDone(jobId, salvaged).catch(() => {});
        // It is not going to be worked any further, so it should stop showing
        // up as active work alongside the user's own plans.
        await closeMissionPlan(state).catch(() => {});
        if (job) await logTurn(job, { result: salvaged });
        await announce(jobId, { title: salvaged.title, body: salvaged.answer }).catch(() => {});
        return send(res, 200, {
          ok: true,
          status: salvaged.incomplete ? 'incomplete' : 'done',
          answer: salvaged.answer,
          error: message,
        });
      }

      await markFailed(jobId, message).catch(() => {});
      // A job that broke is still a turn in the conversation, and the history
      // is the only place it would otherwise be recorded.
      if (job) await logTurn(job, { error: message });
      // A job that died silently is indistinguishable from one still thinking,
      // which is the worst thing to leave someone holding a phone.
      await announce(jobId, { title: 'Oscar got stuck', body: message }).catch(() => {});
    }
    return send(res, 200, { ok: false, status: 'failed', error: message });
  }
}
