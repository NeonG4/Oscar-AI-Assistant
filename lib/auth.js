/**
 * lib/auth.js
 * ----------------------------------------------------------------------------
 * Password + emailed-code login, with no database.
 *
 * The trick that removes the database: both the mid-login "challenge" and the
 * finished "session" are HMAC-signed tokens. The server can verify either one
 * without having stored anything, because it re-computes the signature with a
 * secret only it knows.
 *
 *   step 1  password  ──▶  server emails a code, hands back a signed
 *                          challenge token containing a HASH of that code
 *   step 2  code + challenge  ──▶  server re-hashes the code, compares,
 *                                  and sets a signed session cookie
 *
 * The code itself is never stored anywhere, and the challenge token is useless
 * without the code that was emailed.
 *
 * Known tradeoff of going stateless: a code stays usable for its full 10-minute
 * window even after a successful login, and there is no lockout counter. To get
 * true single-use codes and lockouts you need a shared store — see the note in
 * README.md under "Hardening further".
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'oscar_session';
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes to type the code
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Deliberately excludes I, O, 0 and 1 so nothing is ambiguous when read off a
 * phone screen. 32 symbols ^ 6 places ≈ 1.07 billion possible codes.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ secrets */

/**
 * Signing key for both token types. Falls back to the Shortcut's shared secret
 * so there is one less thing to configure, but its own value is better:
 * rotating it then logs every browser out without breaking the Shortcut.
 */
export function sessionSecret(env = process.env) {
  const secret = env.OSCAR_SESSION_SECRET || env.OSCAR_SHARED_SECRET;
  if (!secret) throw new AuthError('Server is missing OSCAR_SESSION_SECRET.', 500);
  return secret;
}

export function ownerEmail(env = process.env) {
  const email = (env.OSCAR_OWNER_EMAIL || '').trim();
  if (!email) throw new AuthError('Server is missing OSCAR_OWNER_EMAIL.', 500);
  return email;
}

/** Compare without leaking length or position through timing. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) {
    // Still burn a comparison so the failure isn't measurably faster.
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/**
 * Check the login password against OSCAR_PASSKEY, or against
 * OSCAR_PASSKEY_HASH (sha256 hex) if you'd rather not keep the plaintext in
 * your Vercel dashboard. Generate a hash with:
 *   node -e "console.log(require('crypto').createHash('sha256').update('mypass').digest('hex'))"
 */
export function checkPassword(input, env = process.env) {
  const supplied = String(input ?? '');
  if (!supplied) return false;

  if (env.OSCAR_PASSKEY_HASH) {
    const digest = crypto.createHash('sha256').update(supplied, 'utf8').digest('hex');
    return safeEqual(digest, String(env.OSCAR_PASSKEY_HASH).trim().toLowerCase());
  }

  if (env.OSCAR_PASSKEY) return safeEqual(supplied, env.OSCAR_PASSKEY);

  throw new AuthError('Server is missing OSCAR_PASSKEY.', 500);
}

/* ------------------------------------------------------------------- tokens */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signature(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/** `<base64url payload>.<base64url hmac>` — same construction as a JWT, minus the header. */
export function signToken(payload, secret) {
  const data = b64url(JSON.stringify(payload));
  return `${data}.${signature(data, secret)}`;
}

/** @returns the payload, or null if the token is malformed, forged, or expired. */
export function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [data, sig] = token.split('.', 2);
  if (!data || !sig) return null;
  if (!safeEqual(sig, signature(data, secret))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;

  return payload;
}

/* --------------------------------------------------------------- 2FA codes */

export function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    // 256 % 32 === 0, so the modulo introduces no bias here.
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Forgiving input cleanup: case, spaces and dashes are all ignored. */
export function normalizeCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function hashCode(code, secret) {
  return crypto.createHmac('sha256', secret).update(`code:${code}`).digest('base64url');
}

/**
 * Build the token handed to the browser between step 1 and step 2.
 * It carries only a hash of the code, so intercepting it does not reveal the code.
 */
export function createChallenge({ code, userAgent }, secret, now = Date.now()) {
  return signToken(
    {
      t: 'challenge',
      ch: hashCode(code, secret),
      ua: fingerprint(userAgent, secret),
      iat: now,
      exp: now + CHALLENGE_TTL_MS,
    },
    secret
  );
}

/** Binds a token to the browser that requested it. User-agent only — IPs change on cellular. */
export function fingerprint(userAgent, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(String(userAgent || 'unknown'))
    .digest('base64url')
    .slice(0, 16);
}

/** @throws {AuthError} with a message safe to show the user. */
export function verifyChallenge({ challenge, code, userAgent }, secret) {
  const payload = verifyToken(challenge, secret);
  if (!payload || payload.t !== 'challenge') {
    throw new AuthError('That login attempt expired. Start again.');
  }
  if (payload.ua !== fingerprint(userAgent, secret)) {
    throw new AuthError('That code was requested from a different browser.');
  }

  const normalized = normalizeCode(code);
  if (normalized.length !== CODE_LENGTH) {
    throw new AuthError(`Enter the ${CODE_LENGTH}-character code from your email.`, 400);
  }
  if (!safeEqual(hashCode(normalized, secret), payload.ch)) {
    throw new AuthError('That code is not right.');
  }
  return true;
}

/* ------------------------------------------------------------------ session */

export function createSession(email, secret, now = Date.now()) {
  return signToken(
    { t: 'session', sub: email, iat: now, exp: now + SESSION_TTL_MS },
    secret
  );
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * HttpOnly so page scripts can't read it (an XSS bug can't steal the session).
 * SameSite=Lax so it isn't sent on cross-site requests.
 * Secure because Vercel is always HTTPS.
 */
export function sessionCookie(token, { maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  return parts.join('; ');
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** @returns the session payload for this request, or null. */
export function getSession(req, env = process.env) {
  let secret;
  try {
    secret = sessionSecret(env);
  } catch {
    return null;
  }
  const token = parseCookies(req.headers && req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifyToken(token, secret);
  return payload && payload.t === 'session' ? payload : null;
}

/** Slows down scripted guessing a little. Cheap insurance, ~free in wall time. */
export function penaltyDelay(ms = 400) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `da***@gmail.com` — enough to confirm the right inbox without publishing it. */
export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return 'your email';
  const head = user.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}
