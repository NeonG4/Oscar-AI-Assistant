/**
 * lib/google/auth.js
 * ----------------------------------------------------------------------------
 * Turns a stored refresh token into a usable access token, and wraps every
 * Google API call.
 *
 * HOW THE CREDENTIALS WORK
 *
 *   client id + secret  identify the *application* (created once in Google
 *                       Cloud Console)
 *   refresh token       identifies *your account's grant* to that application.
 *                       Obtained once by running `npm run google-auth`, then
 *                       pasted into Vercel. Long-lived.
 *   access token        short-lived (about an hour), minted from the refresh
 *                       token on demand. Never stored anywhere.
 *
 * THE TRAP THAT BREAKS THIS AFTER EXACTLY ONE WEEK
 *
 * Google's docs: "A Google Cloud Platform project with an OAuth consent screen
 * configured for an external user type and a publishing status of 'Testing' is
 * issued a refresh token expiring in 7 days." A brand new project defaults to
 * Testing. So everything works, and then a week later every Google tool starts
 * failing with invalid_grant. You must set the publishing status to
 * "In production" — see GOOGLE.md. The error message below says so explicitly,
 * because a week from now nobody remembers this.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 8000;

/**
 * Scopes are split by what they let you do, so read-only deployments can
 * request genuinely less. Order matters only for readability.
 */
export const SCOPES = {
  read: [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/tasks.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/documents.readonly',
  ],
  write: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
    // gmail.modify covers reading, labelling and drafts. Sending is a separate
    // scope on purpose — Google treats "can send mail as you" as its own grant.
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    // Full Drive rather than drive.file, because drive.file only ever sees
    // files this app itself created — which makes "find my lease agreement"
    // impossible. That is a real widening of access; see GOOGLE.md.
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
  ],
};

export function scopesFor(env = process.env) {
  return env.OSCAR_ALLOW_WRITES === '1' ? SCOPES.write : SCOPES.read;
}

export class GoogleAuthError extends Error {
  constructor(message, { needsReauth = false } = {}) {
    super(message);
    this.name = 'GoogleAuthError';
    this.needsReauth = needsReauth;
  }
}

export class GoogleApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
  }
}

/** @returns {{clientId,clientSecret,refreshToken}|null} */
export function googleConfig(env = process.env) {
  const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = (env.GOOGLE_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

export function isGoogleConfigured(env = process.env) {
  return googleConfig(env) !== null;
}

export function canWriteGoogle(env = process.env) {
  return env.OSCAR_ALLOW_WRITES === '1';
}

/**
 * Access tokens last about an hour, and a Vercel function instance often
 * survives several requests, so caching one at module scope saves a round trip
 * on every warm invocation. Keyed by refresh token so rotating the token in
 * Vercel doesn't serve a stale access token from a warm instance.
 */
const tokenCache = new Map();

/** Refresh a minute early — clock skew and network latency both eat into it. */
const EXPIRY_MARGIN_MS = 60_000;

export function clearTokenCache() {
  tokenCache.clear();
}

/**
 * @returns {Promise<string>} a valid access token
 * @throws {GoogleAuthError} with a message safe to read aloud in a notification
 */
export async function getAccessToken(deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const now = deps.now ?? Date.now(); // ?? not || — a now of 0 is legitimate

  const config = googleConfig(env);
  if (!config) {
    throw new GoogleAuthError(
      'Google is not connected. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.'
    );
  }

  const cached = tokenCache.get(config.refreshToken);
  if (cached && cached.expiresAt > now + EXPIRY_MARGIN_MS) return cached.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    throw new GoogleAuthError(
      err && err.name === 'AbortError'
        ? 'Google took too long to hand back a token.'
        : 'Could not reach Google to refresh access.'
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (!res.ok) {
    let code = '';
    try {
      code = JSON.parse(text).error || '';
    } catch {
      /* ignore */
    }

    // The one failure worth explaining in full, because the cause is invisible
    // and the fix is not obvious.
    if (code === 'invalid_grant') {
      throw new GoogleAuthError(
        'Google access has expired. The usual cause is the OAuth app still being in "Testing" ' +
          'status, which expires refresh tokens after 7 days — set it to "In production" in ' +
          'Google Auth Platform, then run the authorisation script again.',
        { needsReauth: true }
      );
    }

    throw new GoogleAuthError(`Google refused to refresh access (${code || res.status}).`, {
      needsReauth: res.status === 400 || res.status === 401,
    });
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new GoogleAuthError('Google sent back something unreadable.');
  }

  if (!payload.access_token) throw new GoogleAuthError('Google did not return an access token.');

  tokenCache.set(config.refreshToken, {
    token: payload.access_token,
    expiresAt: now + (Number(payload.expires_in) || 3600) * 1000,
  });

  return payload.access_token;
}

/**
 * Call a Google API endpoint with a fresh access token.
 *
 * @param {string} url
 * @param {{method?: string, body?: object, timeoutMs?: number, raw?: boolean}} [options]
 *   raw: return the response body as a string rather than parsing JSON. Drive's
 *   export endpoint returns text/plain, so it cannot go through JSON.parse.
 */
export async function googleFetch(url, options = {}, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const accessToken = await getAccessToken(deps);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);

  let res;
  try {
    res = await doFetch(url, {
      method: options.method || 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new GoogleApiError(
      err && err.name === 'AbortError' ? 'Google took too long to respond.' : 'Could not reach Google.',
      504
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (!res.ok) {
    let message = `Google returned HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      message = (parsed.error && (parsed.error.message || parsed.error)) || message;
    } catch {
      /* keep default */
    }

    // 403 here nearly always means the API is switched off in Cloud Console, or
    // the grant lacks the scope. Both are fixed by a person, not a retry.
    if (res.status === 403) {
      throw new GoogleApiError(
        `Google denied that request: ${message}. Check the API is enabled in Cloud Console and ` +
          'that you re-authorised after adding scopes.',
        403
      );
    }
    if (res.status === 401) {
      clearTokenCache();
      throw new GoogleApiError('Google rejected the access token. Re-run the authorisation script.', 401);
    }

    throw new GoogleApiError(message, res.status);
  }

  if (options.raw) return text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleApiError('Google sent back something unreadable.', 502);
  }
}
