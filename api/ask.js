/**
 * api/ask.js
 * ----------------------------------------------------------------------------
 * The endpoint the iOS Shortcut talks to.
 *
 *   POST /api/ask
 *   headers: { "content-type": "application/json", "x-oscar-key": "<secret>" }
 *   body:    { "question": "how long do I boil an egg for a soft yolk" }
 *
 *   200 -> { "ok": true, "title": "...", "answer": "...", "detail": "...", ... }
 *   4xx/5xx -> { "ok": false, "title": "Oscar failed", "answer": "<why>" }
 *
 * TWO WAYS IN, because the two callers have different constraints:
 *
 *   1. `x-oscar-key` header — for the Shortcut. Shortcuts can't check an email
 *      inbox, so it uses a long shared secret that lives on your phone.
 *   2. Login session cookie — for the browser console, set by /api/auth after
 *      the password + emailed code.
 *
 * Errors deliberately return the same shape as success, because the Shortcut
 * reads `answer` and shows it in a notification either way. A failure then
 * shows up on your lock screen as readable text instead of silently doing
 * nothing.
 *
 * Every request is logged to Supabase when it's configured — successes and
 * failures both. See lib/db.js for why logging can never break an answer.
 */

import { askAgent, AgentError } from '../lib/agent.js';
import { getSession, safeEqual, penaltyDelay } from '../lib/auth.js';
import { applyCors, readBody, send, HttpError } from '../lib/http.js';
import { logConversation, conversationRow } from '../lib/db.js';

/**
 * @returns {'session'|'key'|null} how this request authenticated, if at all.
 */
function authenticate(req, url, body) {
  if (getSession(req)) return 'session';

  const expected = process.env.OSCAR_SHARED_SECRET;
  if (!expected) return null;

  const provided =
    req.headers['x-oscar-key'] ||
    url.searchParams.get('key') ||
    body.key ||
    (typeof req.headers.authorization === 'string'
      ? req.headers.authorization.replace(/^Bearer\s+/i, '')
      : '');

  return safeEqual(provided, expected) ? 'key' : null;
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return send(res, 405, {
      ok: false,
      title: 'Oscar failed',
      answer: 'Use POST (or GET with ?q=) to ask a question.',
    });
  }

  const startedAt = Date.now();

  // Declared out here so the catch block can still log what was being asked.
  let question = '';
  let timeZone;
  let via = null;
  let source = null;

  try {
    const url = new URL(req.url, 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : {};

    // ---- auth -------------------------------------------------------------
    via = authenticate(req, url, body);
    if (!via) {
      await penaltyDelay(250);
      return send(res, 401, {
        ok: false,
        title: 'Oscar failed',
        answer: process.env.OSCAR_SHARED_SECRET
          ? 'Not authorised. Sign in on the website, or check the x-oscar-key header in the Shortcut.'
          : 'Server is missing OSCAR_SHARED_SECRET, so nothing can authenticate.',
        detail: '',
        speak: 'Not authorised.',
      });
      // Note: unauthorised requests are deliberately NOT logged. Otherwise
      // anyone who finds the URL could fill your database for free.
    }

    // ---- input ------------------------------------------------------------
    question =
      body.question ||
      body.q ||
      body.text ||
      url.searchParams.get('q') ||
      url.searchParams.get('question') ||
      '';

    timeZone = body.tz || body.timeZone || url.searchParams.get('tz') || undefined;
    source = body.source || (via === 'key' ? 'shortcut' : 'console');

    const result = await askAgent({ question, timeZone }, { env: process.env });

    // Awaited on purpose: on serverless the function can be frozen the instant
    // a response is sent, so a fire-and-forget insert would vanish some of the
    // time. ~50-150ms against a multi-second request is a fair price for a log
    // you can trust. lib/db.js no-ops when Supabase isn't configured.
    await logConversation(
      conversationRow({
        question,
        timeZone,
        result,
        status: 200,
        via,
        source,
        totalMs: Date.now() - startedAt,
      })
    );

    return send(res, 200, {
      ok: true,
      question: String(question).trim(),
      title: result.title,
      answer: result.answer,
      detail: result.detail,
      // `speak` is what you feed into a "Speak Text" action if you want it read
      // aloud: answer + detail merged.
      speak: result.detail ? `${result.answer} ${result.detail}` : result.answer,
      model: result.model,
      elapsedMs: result.elapsedMs,
      via,
    });
  } catch (err) {
    const status = err instanceof AgentError || err instanceof HttpError ? err.status : 500;
    const message =
      err instanceof AgentError || err instanceof HttpError
        ? err.message
        : 'Something broke on the server.';
    const full = err && err.detail ? `${message} (${err.detail})` : message;

    if (status >= 500) console.error('[oscar] ', err);

    // Failures are logged too. A table recording only successes hides exactly
    // what you need when something breaks.
    if (via) {
      await logConversation(
        conversationRow({
          question,
          timeZone,
          error: full,
          status,
          via,
          source,
          totalMs: Date.now() - startedAt,
        })
      );
    }

    return send(res, status, {
      ok: false,
      title: 'Oscar failed',
      answer: full,
      detail: '',
      speak: message,
    });
  }
}
