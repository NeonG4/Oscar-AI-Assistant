/**
 * lib/db.js
 * ----------------------------------------------------------------------------
 * Supabase logging, over plain HTTPS.
 *
 * Supabase exposes every table as a REST API (PostgREST), so a table insert is
 * just a POST — no npm dependency needed, which keeps `npm install` unnecessary
 * for this project.
 *
 * Two design rules, both deliberate:
 *
 *   1. LOGGING NEVER BREAKS AN ANSWER. Every function here swallows its own
 *      errors and reports failure through a return value. If Supabase is down,
 *      paused, or misconfigured, you still get your answer — you just don't get
 *      a row. A logging layer that can take down the thing it's logging is worse
 *      than no logging at all.
 *
 *   2. UNCONFIGURED IS A VALID STATE. With no Supabase env vars set, everything
 *      no-ops quietly. The project works exactly as it did before.
 *
 * The key used here is the SERVICE ROLE key, which bypasses Row Level Security.
 * That is why it may only ever live server-side, and why `public/` must never
 * see it.
 */

const DEFAULT_TABLE = 'conversations';
const TIMEOUT_MS = 4000;

/** @returns {{url: string, key: string, table: string}|null} */
export function dbConfig(env = process.env) {
  const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  return { url, key, table: (env.SUPABASE_TABLE || DEFAULT_TABLE).trim() };
}

export function isConfigured(env = process.env) {
  return dbConfig(env) !== null;
}

/**
 * A request that gives up rather than holding the response hostage.
 * Four seconds is generous for a single-row insert; past that, something is
 * wrong and the answer matters more than the log line.
 */
async function request(path, init, config, doFetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await doFetch(`${config.url}/rest/v1/${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        apikey: config.key,
        authorization: `Bearer ${config.key}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: detail.slice(0, 300) };
    }

    const text = await res.text();
    return { ok: true, status: res.status, data: text ? JSON.parse(text) : null };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return { ok: false, error: aborted ? `timed out after ${TIMEOUT_MS}ms` : String(err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

/** Strip undefined so PostgREST uses column defaults instead of erroring. */
function compact(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Write one conversation row.
 *
 * Deliberately returns a result object instead of throwing — callers log the
 * failure and carry on.
 *
 * @returns {Promise<{ok: boolean, skipped?: boolean, error?: string}>}
 */
export async function logConversation(row, deps = {}) {
  const env = deps.env || process.env;
  const config = dbConfig(env);
  if (!config) return { ok: true, skipped: true };

  const doFetch = deps.fetchImpl || globalThis.fetch;

  const result = await request(
    config.table,
    {
      method: 'POST',
      // Minimal: don't ship the inserted row back over the wire, we don't use it.
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify(compact(row)),
    },
    config,
    doFetch
  );

  if (!result.ok) {
    console.error(`[oscar] could not log to supabase: ${result.error || result.status}`);
    return { ok: false, error: result.error };
  }

  return { ok: true };
}

/**
 * Read recent conversations, newest first.
 *
 * @param {{limit?: number, search?: string, before?: string}} [opts]
 * @returns {Promise<{ok: boolean, rows: object[], skipped?: boolean, error?: string}>}
 */
export async function recentConversations(opts = {}, deps = {}) {
  const env = deps.env || process.env;
  const config = dbConfig(env);
  if (!config) return { ok: true, rows: [], skipped: true };

  const doFetch = deps.fetchImpl || globalThis.fetch;

  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 100);
  const params = new URLSearchParams({
    select: 'id,created_at,question,answer,detail,title,ok,error,model,via,source,total_ms,total_tokens',
    order: 'created_at.desc',
    limit: String(limit),
  });

  if (opts.search) {
    // PostgREST reserves , . : ( ) inside filter values, so strip them rather
    // than risk building a malformed — or worse, unintended — filter.
    const term = String(opts.search).replace(/[,.:()*%]/g, ' ').trim().slice(0, 80);
    if (term) params.set('question', `ilike.*${term}*`);
  }

  if (opts.before) params.set('created_at', `lt.${opts.before}`);

  const result = await request(`${config.table}?${params}`, { method: 'GET' }, config, doFetch);

  if (!result.ok) {
    console.error(`[oscar] could not read from supabase: ${result.error || result.status}`);
    return { ok: false, rows: [], error: result.error };
  }

  return { ok: true, rows: Array.isArray(result.data) ? result.data : [] };
}

/**
 * Confirms the table exists and the key works, without writing anything.
 * Used by /api/health so a broken setup is visible before you rely on it.
 */
export async function pingDatabase(deps = {}) {
  const env = deps.env || process.env;
  const config = dbConfig(env);
  if (!config) return { configured: false, reachable: false };

  const doFetch = deps.fetchImpl || globalThis.fetch;
  const result = await request(
    `${config.table}?select=id&limit=1`,
    { method: 'GET' },
    config,
    doFetch
  );

  return {
    configured: true,
    reachable: result.ok,
    error: result.ok ? undefined : result.error || `HTTP ${result.status}`,
  };
}

/**
 * Shapes an /api/ask outcome into a table row.
 * Kept next to the schema knowledge rather than inside the route handler.
 */
export function conversationRow({ question, timeZone, result, error, status, via, source, totalMs }) {
  const usage = (result && result.usage) || {};

  return {
    question: String(question || '').slice(0, 8000),
    time_zone: timeZone || null,
    answer: result ? result.answer : null,
    detail: result ? result.detail || null : null,
    title: result ? result.title : null,
    ok: !error,
    error: error ? String(error).slice(0, 500) : null,
    status: status || (error ? 500 : 200),
    model: result ? result.model : null,
    via: via || null,
    source: source || null,
    elapsed_ms: result ? result.elapsedMs : null,
    total_ms: totalMs ?? null,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
  };
}
