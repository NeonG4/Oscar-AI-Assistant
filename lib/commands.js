/**
 * lib/commands.js
 * ----------------------------------------------------------------------------
 * The queue of shell commands waiting for your own machine.
 *
 * THE DIRECTION OF TRAVEL IS THE WHOLE DESIGN
 *
 * Oscar runs on Vercel. Your laptop is behind NAT with no inbound port and is
 * asleep half the time, so the server can never call INTO it. Instead the
 * laptop calls out: scripts/runner.js polls /api/runner, claims the oldest
 * queued row, runs it, and posts the result back here.
 *
 * That inversion buys three things. No port forwarding, no dynamic DNS, no
 * inbound firewall hole. The laptop can be shut without anything failing —
 * commands just sit here until it wakes. And the laptop keeps the final say on
 * what actually executes, which is the security property that matters most.
 *
 * A ROW HERE IS A REQUEST, NOT AN AUTHORISATION. The runner applies its own
 * allowlist and refuses anything it dislikes no matter what this table says.
 * If this database or the deployment were ever compromised, the laptop still
 * says no. Never move that check server-side for convenience.
 */

import { dbRequest, isConfigured } from './db.js';

export { isConfigured as isCommandsConfigured };

/** Nobody collected it in this long -> the laptop was off. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Longest a single command may run before the runner kills it. */
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 30 * 1000;

/** Output kept per stream. Enough to be useful, small enough to stay in a row. */
export const MAX_OUTPUT_CHARS = 20000;

export class CommandError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'CommandError';
    this.status = status;
  }
}

export function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), 1000), MAX_TIMEOUT_MS);
}

/** Keep the head and the tail — both ends of a long log are the interesting parts. */
export function clampOutput(text, limit = MAX_OUTPUT_CHARS) {
  const s = String(text == null ? '' : text);
  if (s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  const dropped = s.length - limit;
  return `${s.slice(0, half)}\n\n... [${dropped} characters trimmed] ...\n\n${s.slice(-half)}`;
}

function tidy(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    command: row.command,
    cwd: row.cwd || undefined,
    reason: row.reason || undefined,
    timeoutMs: row.timeout_ms,
    exitCode: row.exit_code == null ? undefined : row.exit_code,
    stdout: row.stdout || undefined,
    stderr: row.stderr || undefined,
    error: row.error || undefined,
    runner: row.runner || undefined,
    createdAt: row.created_at,
    claimedAt: row.claimed_at || undefined,
    finishedAt: row.finished_at || undefined,
  };
}

export { tidy as tidyCommand };

/** Terminal states — nothing further will happen to these. */
export function isSettled(status) {
  return ['done', 'failed', 'refused', 'expired'].includes(String(status));
}

/* --------------------------------------------------------------------- CRUD */

export async function queueCommand(input, deps = {}) {
  if (!isConfigured(deps.env || process.env)) {
    throw new CommandError('No database is configured, so I cannot reach your computer.', 503);
  }

  const command = String(input.command || '').trim();
  if (!command) throw new CommandError('No command was given.', 400);

  const row = {
    command: command.slice(0, 4000),
    cwd: input.cwd ? String(input.cwd).slice(0, 500) : null,
    reason: input.reason ? String(input.reason).slice(0, 500) : null,
    timeout_ms: clampTimeout(input.timeoutMs),
    status: 'queued',
    job_id: input.jobId || null,
    via: input.via || null,
  };

  const result = await dbRequest(
    'commands',
    { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row) },
    deps
  );
  if (!result.ok) throw new CommandError(`Could not queue the command: ${result.error || result.status}`);

  const saved = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!saved || !saved.id) throw new CommandError('The database did not return a command id.');
  return tidy(saved);
}

export async function getCommand(id, deps = {}) {
  const result = await dbRequest(
    `commands?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { method: 'GET' },
    deps
  );
  if (!result.ok) throw new CommandError(`Could not load the command: ${result.error || result.status}`);
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row) throw new CommandError('No command with that id.', 404);
  return tidy(row);
}

export async function listCommands(opts = {}, deps = {}) {
  const params = new URLSearchParams({
    select: '*',
    order: 'created_at.desc',
    limit: String(Math.min(Math.max(Number(opts.limit) || 20, 1), 50)),
  });
  if (opts.status && opts.status !== 'all') params.set('status', `eq.${opts.status}`);

  const result = await dbRequest(`commands?${params}`, { method: 'GET' }, deps);
  if (!result.ok) throw new CommandError(`Could not list commands: ${result.error || result.status}`);
  return (Array.isArray(result.data) ? result.data : []).map(tidy);
}

/* ------------------------------------------------------------------ claiming */

/**
 * Hand the oldest queued command to a runner, exactly once.
 *
 * PostgREST has no "select for update skip locked", so this is optimistic:
 * read the oldest queued row, then PATCH it with `status=eq.queued` still in
 * the filter. If another runner got there first the filter matches nothing,
 * the response comes back empty, and we simply try the next one. Two runners
 * can therefore never execute the same command — which matters more here than
 * in most queues, because the side effects land on a real machine.
 */
export async function claimNext({ runner, attempts = 3 } = {}, deps = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const params = new URLSearchParams({
      select: '*',
      status: 'eq.queued',
      order: 'created_at.asc',
      limit: '1',
    });
    const pending = await dbRequest(`commands?${params}`, { method: 'GET' }, deps);
    if (!pending.ok) throw new CommandError(`Could not read the queue: ${pending.error || pending.status}`);

    const row = Array.isArray(pending.data) ? pending.data[0] : pending.data;
    if (!row) return null;

    // Too old to be worth running — the laptop was off when it was asked for.
    const age = Date.now() - new Date(row.created_at).getTime();
    if (age > CLAIM_TTL_MS) {
      await settleCommand(row.id, { status: 'expired', error: 'Nobody collected this in time.' }, deps);
      continue;
    }

    const claimed = await dbRequest(
      `commands?id=eq.${encodeURIComponent(row.id)}&status=eq.queued`,
      {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'claimed',
          claimed_at: new Date().toISOString(),
          runner: runner ? String(runner).slice(0, 200) : null,
        }),
      },
      deps
    );
    if (!claimed.ok) throw new CommandError(`Could not claim the command: ${claimed.error || claimed.status}`);

    const got = Array.isArray(claimed.data) ? claimed.data[0] : claimed.data;
    if (got) return tidy(got);
    // Lost the race. Go round again for the next one.
  }
  return null;
}

/** Record the outcome. `status` is done | failed | refused | expired. */
export async function settleCommand(id, outcome, deps = {}) {
  const body = {
    status: outcome.status || 'done',
    finished_at: new Date().toISOString(),
  };
  if (outcome.exitCode !== undefined) body.exit_code = outcome.exitCode;
  if (outcome.stdout !== undefined) body.stdout = clampOutput(outcome.stdout);
  if (outcome.stderr !== undefined) body.stderr = clampOutput(outcome.stderr);
  if (outcome.error !== undefined) body.error = String(outcome.error || '').slice(0, 1000);

  const result = await dbRequest(
    `commands?id=eq.${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(body) },
    deps
  );
  if (!result.ok) throw new CommandError(`Could not save the result: ${result.error || result.status}`);
  return true;
}
