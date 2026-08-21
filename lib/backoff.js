/**
 * lib/backoff.js
 * ----------------------------------------------------------------------------
 * Retrying the model provider when it says "not right now".
 *
 * The error that made this file exist:
 *
 *   Rate limit reached for gpt-4o ... on tokens per min (TPM): Limit 30000,
 *   Used 28935, Requested 2033. Please try again in 1.936s.
 *
 * Read that carefully and it is not a failure at all — it is a queue ticket.
 * The account was two seconds away from being allowed to make exactly the call
 * it was making, and the whole request was thrown away instead of waiting. A
 * tool loop makes this worse than it sounds: every round resends the entire
 * conversation, so a long run spends tokens per minute on an accelerating curve
 * and walks into the limit at the point where it has done the most work and has
 * the most to lose.
 *
 * So: wait the two seconds. The provider even says how long to wait, in three
 * different places, and this file reads all of them before falling back to
 * guessing.
 *
 * WHAT IS NOT RETRIED. A 429 comes in two flavours and only one is worth
 * sleeping on. `rate_limit_exceeded` means "too fast, try again";
 * `insufficient_quota` means the card was declined and will still mean that in
 * an hour. Retrying the second turns an instant clear error into a slow
 * identical one, so it is passed straight through — as is every other 4xx,
 * which says the request itself was wrong and will be wrong again.
 *
 * EVERY WAIT COMES OUT OF A BUDGET the caller sets, because on Vercel the
 * function is killed at 60 seconds whatever this file thinks. `budgetMs` covers
 * the whole operation, sleeps included; when the next attempt would not fit in
 * what is left, the last response is returned as-is rather than being started
 * and then cut off half-way.
 */

/** Retried: the provider is busy or briefly broken, and the request was fine. */
export function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * A 429 that will not go away on its own — no quota left, or a billing problem.
 * Waiting on one of these only makes the user stare at a spinner first.
 */
export function isPermanentQuotaError(detail) {
  return /insufficient_quota|exceeded your current quota|billing|payment/i.test(String(detail || ''));
}

/** Read one header off either a real Headers object or a plain-object stub. */
export function headerValue(res, name) {
  const headers = res && res.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const direct = headers[name] === undefined ? headers[name.toLowerCase()] : headers[name];
  return direct === undefined ? null : direct;
}

/**
 * Parse the duration strings the provider uses: "1.936s", "300ms", "6m0s".
 * Compound values are summed, so "1m30s" is 90000.
 */
export function parseDuration(text, { bareUnitMs = 1000 } = {}) {
  const str = String(text === null || text === undefined ? '' : text).trim();
  if (!str) return null;

  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;

  let total = 0;
  let found = false;
  let match;
  while ((match = re.exec(str))) {
    total += parseFloat(match[1]) * units[match[2]];
    found = true;
  }
  if (found) return total;

  // A unitless number carries the unit of whatever named it: seconds for
  // Retry-After, milliseconds for Retry-After-Ms. Getting this backwards turns
  // a 400ms wait into a 400-second one, which is a hang, not a retry.
  if (/^\d+(?:\.\d+)?$/.test(str)) return parseFloat(str) * bareUnitMs;

  // Retry-After is allowed to be an HTTP date instead.
  const when = Date.parse(str);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());

  return null;
}

/**
 * How long the provider itself asked us to wait, or null if it never said.
 *
 * Checked in order of how specific each source is. The reset headers come last
 * because they describe when the bucket refills completely, which is a longer
 * wait than the one actually needed.
 */
export function providerRetryMs(res, detail) {
  const fromMessage = String(detail || '').match(/try again in ([\d.]+\s*(?:ms|s|m|h))/i);

  const candidates = [
    [headerValue(res, 'retry-after-ms'), 1],
    [headerValue(res, 'retry-after'), 1000],
    // The message text carries the precise figure even when no header does.
    [fromMessage && fromMessage[1], 1000],
    [headerValue(res, 'x-ratelimit-reset-tokens'), 1000],
    [headerValue(res, 'x-ratelimit-reset-requests'), 1000],
  ];

  for (const [candidate, bareUnitMs] of candidates) {
    const ms = parseDuration(candidate, { bareUnitMs });
    if (ms !== null && ms >= 0) return ms;
  }
  return null;
}

/** Exponential base, doubled per attempt, before jitter. */
export const BASE_DELAY_MS = 500;

/** No single wait longer than this, however patient the caller is. */
export const MAX_DELAY_MS = 8000;

/** Below this there is no point starting another attempt at all. */
export const MIN_ATTEMPT_MS = 1200;

/**
 * How long to sleep before the next attempt.
 *
 * A figure from the provider is used almost verbatim — it is the truth, and
 * guessing longer only wastes the user's time — plus a small pad, because "try
 * again in 1.936s" means the limit clears AT 1.936s, not before. With no figure
 * to go on it is ordinary jittered exponential backoff. The jitter matters
 * because two of these can be in flight at once (a question and the background
 * catch on the same sentence), and identical retries would collide again on the
 * same token bucket.
 */
export function backoffDelay(attempt, { res, detail, random = Math.random } = {}) {
  const asked = providerRetryMs(res, detail);
  if (asked !== null) return Math.min(MAX_DELAY_MS, asked + 250);

  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  // Full jitter, floored so that a "retry" is never effectively instant.
  return Math.max(Math.round(BASE_DELAY_MS / 2), Math.round(ceiling * random()));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many attempts a call gets in total. One reproduces the old behaviour. */
export function maxAttempts(env = process.env, fallback = 3) {
  const raw = Number(env.OSCAR_OPENAI_MAX_ATTEMPTS);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(6, Math.floor(raw));
}

/** Pull the human-readable message out of a provider error body. */
export function errorDetail(rawText) {
  const raw = String(rawText || '');
  try {
    const parsed = JSON.parse(raw);
    return (parsed.error && parsed.error.message) || raw.slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

/**
 * POST to the provider, retrying the failures that are worth retrying.
 *
 * Returns `{res, rawText, attempts, waitedMs}` for whatever the last attempt
 * produced, including a failed one. Deciding what a 4xx MEANS is still the
 * caller's job, exactly as it was before; this only stops the failures that
 * should never have reached the caller from doing so. The body is read here
 * because the retry decision needs it and a Response body reads only once.
 *
 * Throws only what fetch itself throws: a network error, or an AbortError when
 * the budget ran out mid-flight.
 *
 * @param {Function} doFetch
 * @param {string} url
 * @param {object} init
 * @param {{budgetMs?: number, attempts?: number, sleep?: Function, random?: Function, onRetry?: Function}} [opts]
 */
export async function postWithRetry(doFetch, url, init, opts = {}) {
  const budgetMs = typeof opts.budgetMs === 'number' ? opts.budgetMs : 45000;
  const attemptCap = Math.max(1, opts.attempts || 1);
  const sleep = opts.sleep || wait;
  const started = Date.now();

  let attempt = 0;
  let waitedMs = 0;

  for (;;) {
    attempt += 1;

    // Every attempt is capped by what is left of the WHOLE operation, so a
    // retry can never push the caller past the deadline it was handed.
    const remaining = budgetMs - (Date.now() - started);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, remaining));

    let res;
    let rawText;
    try {
      res = await doFetch(url, { ...init, signal: controller.signal });
      rawText = await res.text();
    } finally {
      clearTimeout(timer);
    }

    if (res.ok || attempt >= attemptCap) return { res, rawText, attempts: attempt, waitedMs };

    const detail = errorDetail(rawText);
    if (!isRetryableStatus(res.status)) return { res, rawText, attempts: attempt, waitedMs };
    if (res.status === 429 && isPermanentQuotaError(detail)) {
      return { res, rawText, attempts: attempt, waitedMs };
    }

    const delay = backoffDelay(attempt, { res, detail, random: opts.random });
    const left = budgetMs - (Date.now() - started);
    // Sleeping is pointless if what remains afterwards is too short to answer in.
    if (delay + MIN_ATTEMPT_MS > left) return { res, rawText, attempts: attempt, waitedMs };

    if (opts.onRetry) opts.onRetry({ attempt, status: res.status, delay, detail });
    await sleep(delay);
    waitedMs += delay;
  }
}
