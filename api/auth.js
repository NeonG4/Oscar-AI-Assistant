/**
 * api/auth.js
 * ----------------------------------------------------------------------------
 * The login endpoint. Three actions on one route.
 *
 *   POST { action: "start",  password }          → emails a code, returns a challenge
 *   POST { action: "verify", challenge, code }   → sets the session cookie
 *   POST { action: "logout" }                    → clears the session cookie
 *
 * Responses never distinguish "wrong password" from "unknown user" in a way
 * that leaks anything, and every failure path is delayed slightly to blunt
 * scripted guessing.
 */

import {
  AuthError,
  CHALLENGE_TTL_MS,
  CODE_LENGTH,
  checkPassword,
  clearCookie,
  createChallenge,
  createSession,
  generateCode,
  getSession,
  maskEmail,
  ownerEmail,
  penaltyDelay,
  sessionCookie,
  sessionSecret,
  verifyChallenge,
} from '../lib/auth.js';
import { sendCode, detectProvider } from '../lib/mailer.js';
import { applyCors, readBody, send, clientIp } from '../lib/http.js';

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, error: 'Use POST.' });
  }

  let action = 'unknown';

  try {
    const body = await readBody(req);
    action = String(body.action || '').toLowerCase();
    const secret = sessionSecret();
    const userAgent = (req.headers && req.headers['user-agent']) || '';

    /* ---------------------------------------------------------- step 1 ---- */
    if (action === 'start') {
      const email = ownerEmail();

      if (!checkPassword(body.password)) {
        await penaltyDelay();
        console.warn(`[oscar] failed password attempt from ${clientIp(req)}`);
        return send(res, 401, { ok: false, error: 'That password is not right.' });
      }

      const code = generateCode();
      const challenge = createChallenge({ code, userAgent }, secret);

      let delivered = false;
      let provider = detectProvider();
      try {
        ({ delivered, provider } = await sendCode({
          to: email,
          code,
          minutes: Math.round(CHALLENGE_TTL_MS / 60000),
        }));
      } catch (err) {
        console.error('[oscar] email send failed:', err && err.detail ? err.detail : err);
        return send(res, 502, {
          ok: false,
          error: 'The code could not be emailed. Check the mail provider key in Vercel.',
        });
      }

      return send(res, 200, {
        ok: true,
        challenge,
        sentTo: maskEmail(email),
        codeLength: CODE_LENGTH,
        expiresInMs: CHALLENGE_TTL_MS,
        // Tells the UI to point you at the server logs when no provider is set up yet.
        delivered,
        provider,
      });
    }

    /* ---------------------------------------------------------- step 2 ---- */
    if (action === 'verify') {
      try {
        verifyChallenge({ challenge: body.challenge, code: body.code, userAgent }, secret);
      } catch (err) {
        await penaltyDelay();
        throw err;
      }

      const email = ownerEmail();
      const token = createSession(email, secret);

      return send(
        res,
        200,
        { ok: true, email: maskEmail(email) },
        { 'set-cookie': sessionCookie(token) }
      );
    }

    /* ---------------------------------------------------------- logout ---- */
    if (action === 'logout') {
      return send(res, 200, { ok: true, authed: false }, { 'set-cookie': clearCookie() });
    }

    /* ---------------------------------------------------------- status ---- */
    if (action === 'status') {
      const session = getSession(req);
      return send(res, 200, {
        ok: true,
        authed: Boolean(session),
        email: session ? maskEmail(session.sub) : null,
      });
    }

    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 500;
    if (status >= 500) console.error(`[oscar] auth (${action}) failed:`, err);
    return send(res, status, {
      ok: false,
      error: err instanceof AuthError ? err.message : 'Login is not working right now.',
    });
  }
}
