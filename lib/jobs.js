/**
 * lib/jobs.js
 * ----------------------------------------------------------------------------
 * Asynchronous agent runs.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A synchronous request is bounded by whoever is waiting on it: an iOS Shortcut
 * gives up after a few seconds, and a Vercel function dies at maxDuration
 * regardless. `waitUntil` does not help — Vercel's docs are explicit that
 * promises passed to it share the function's own timeout.
 *
 * But the budget resets per INVOCATION. So a long run is spread across several:
 * each one loads the state, does what it can, writes the state back, and hands
 * off. The job row is the baton.
 *
 * TWO THINGS CAN CARRY A JOB FORWARD
 *
 *   1. The web app, polling and calling /api/step — gives live progress.
 *   2. The function itself, POSTing to /api/step before it runs out.
 *
 * Both is best: the app shows progress when open, and work continues when it
 * isn't. Either is enough on its own, which is the point — no single component
 * has to stay alive.
 */

import { dbRequest, isConfigured } from './db.js';
import { signToken, verifyToken, sessionSecret } from './auth.js';

export { isConfigured as isJobsConfigured };

/** How long a job may run in total before it is abandoned. */
export const JOB_TTL_MS = 15 * 60 * 1000;

/** Hard ceiling on steps per job, independent of the agent's own budgets. */
export const MAX_JOB_STEPS = 40;

export class JobError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'JobError';
    this.status = status;
  }
}

/* ----------------------------------------------------------- step authority */

/**
 * A short-lived token proving "you may advance THIS job".
 *
 * /api/step must not be drivable by strangers — it spends your OpenAI credit.
 * Rather than putting a long-lived shared secret on an internal call, each hop
 * mints a fresh token for the next one, scoped to a single job id.
 */
export function createJobToken(jobId, env = process.env, now = Date.now()) {
  return signToken({ t: 'job', id: String(jobId), exp: now + JOB_TTL_MS }, sessionSecret(env));
}

/** @returns {string|null} the job id the token authorises, or null. */
export function readJobToken(token, env = process.env) {
  const payload = verifyToken(token, sessionSecret(env));
  return payload && payload.t === 'job' ? payload.id : null;
}

/* --------------------------------------------------------------------- CRUD */

function tidyJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    question: row.question,
    mode: row.mode || undefined,
    model: row.model || undefined,
    steps: row.steps,
    events: Array.isArray(row.events) ? row.events : [],
    title: row.title || undefined,
    answer: row.answer || undefined,
    detail: row.detail || undefined,
    error: row.error || undefined,
    pendingConfirmation: row.pending_confirm || undefined,
    totalTokens: row.total_tokens || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || undefined,
  };
}

export async function createJob(input, deps = {}) {
  if (!isConfigured(deps.env || process.env)) {
    throw new JobError('No database is configured, so background work is unavailable.', 503);
  }

  const row = {
    question: String(input.question || '').slice(0, 4000),
    status: 'queued',
    mode: input.mode || null,
    model: input.model || null,
    state: input.state || null,
    source: input.source || null,
    via: input.via || null,
  };

  const result = await dbRequest(
    'jobs',
    { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row) },
    deps
  );
  if (!result.ok) throw new JobError(`Could not queue the job: ${result.error || result.status}`);

  const job = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!job || !job.id) throw new JobError('The database did not return a job id.');
  return job;
}

/** @returns the raw row, including `state` — callers that expose it must tidy first. */
export async function loadJob(id, deps = {}) {
  const result = await dbRequest(
    `jobs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { method: 'GET' },
    deps
  );
  if (!result.ok) throw new JobError(`Could not load the job: ${result.error || result.status}`);
  const job = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!job) throw new JobError('No job with that id.', 404);
  return job;
}

export async function getJob(id, deps = {}) {
  return tidyJob(await loadJob(id, deps));
}

export async function updateJob(id, patch, deps = {}) {
  const body = { ...patch, updated_at: new Date().toISOString() };
  const result = await dbRequest(
    `jobs?id=eq.${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(body) },
    deps
  );
  if (!result.ok) throw new JobError(`Could not update the job: ${result.error || result.status}`);
  return true;
}

export async function listJobs(opts = {}, deps = {}) {
  const params = new URLSearchParams({
    select: 'id,created_at,updated_at,finished_at,status,question,mode,model,steps,title,answer,error',
    order: 'created_at.desc',
    limit: String(Math.min(Math.max(Number(opts.limit) || 20, 1), 50)),
  });
  if (opts.status && opts.status !== 'all') params.set('status', `eq.${opts.status}`);

  const result = await dbRequest(`jobs?${params}`, { method: 'GET' }, deps);
  if (!result.ok) throw new JobError(`Could not list jobs: ${result.error || result.status}`);
  return (Array.isArray(result.data) ? result.data : []).map(tidyJob);
}

/* ------------------------------------------------------------- transitions */

export async function markRunning(id, deps = {}) {
  return updateJob(id, { status: 'running' }, deps);
}

export async function saveProgress(id, { state, events, steps }, deps = {}) {
  return updateJob(id, { status: 'running', state, events, steps }, deps);
}

export async function markDone(id, result, deps = {}) {
  return updateJob(
    id,
    {
      status: 'done',
      title: result.title || null,
      answer: result.answer || null,
      detail: result.detail || null,
      events: result.events || [],
      steps: result.rounds || 0,
      total_tokens: (result.usage && result.usage.total_tokens) || null,
      model: result.model || null,
      // The message history is the bulk of the row and is useless once the job
      // is finished. Dropping it here keeps the table small.
      state: null,
      pending_confirm: null,
      finished_at: new Date().toISOString(),
    },
    deps
  );
}

export async function markAwaitingConfirm(id, { state, result }, deps = {}) {
  return updateJob(
    id,
    {
      status: 'awaiting_confirm',
      // State is KEPT here, unlike markDone — the run resumes after the answer.
      state,
      events: result.events || [],
      steps: result.rounds || 0,
      title: result.title || null,
      answer: result.answer || null,
      pending_confirm: result.pendingConfirmation || null,
    },
    deps
  );
}

export async function markFailed(id, message, deps = {}) {
  return updateJob(
    id,
    {
      status: 'failed',
      error: String(message || 'Something went wrong.').slice(0, 1000),
      state: null,
      finished_at: new Date().toISOString(),
    },
    deps
  );
}

/**
 * Where to POST to continue a job.
 *
 * VERCEL_URL is the deployment's own hostname, which is what you want for an
 * internal hop — it reaches this exact deployment rather than whatever the
 * production alias currently points at. Returns null when running locally,
 * where self-continuation is skipped and the client drives instead.
 */
export function selfUrl(env = process.env) {
  if (env.OSCAR_BASE_URL) return env.OSCAR_BASE_URL.replace(/\/+$/, '');
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return null;
}

/**
 * Kick off the next invocation and DO NOT wait for it.
 *
 * Deliberately fire-and-forget: awaiting the response would just recreate the
 * problem this whole design exists to avoid. Failures are logged, not thrown —
 * if the hop is lost, the web app polling will pick the job up instead, which
 * is exactly why there are two ways to advance a job.
 */
export function continueJob(jobId, deps = {}) {
  const env = deps.env || process.env;
  const base = selfUrl(env);
  if (!base) return false;

  const doFetch = deps.fetchImpl || globalThis.fetch;
  try {
    doFetch(`${base}/api/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, token: createJobToken(jobId, env) }),
    }).catch((err) => console.error(`[oscar] could not continue job ${jobId}: ${err && err.message}`));
    return true;
  } catch (err) {
    console.error(`[oscar] could not continue job ${jobId}: ${err && err.message}`);
    return false;
  }
}
