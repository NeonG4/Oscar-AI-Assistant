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

import { askAgent, createAgentState, AgentError } from '../lib/agent.js';
import { createMissionState } from '../lib/missions.js';
import { routeQuestion } from '../lib/router.js';
import { createJob, createJobToken, continueJob, isJobsConfigured } from '../lib/jobs.js';
import { getSession, safeEqual, penaltyDelay } from '../lib/auth.js';
import { applyCors, readBody, send, HttpError, clientIp } from '../lib/http.js';
import { logConversation, conversationRow } from '../lib/db.js';
import { createConfirmToken, CONFIRM_TTL_MS } from '../lib/confirm.js';

/**
 * Does this request have authority to change things — send mail, create events?
 *
 * Two independent conditions, both required:
 *   - OSCAR_ALLOW_WRITES=1 on the server (your master switch)
 *   - proof on the request: a full browser login, or the x-oscar-write header
 *
 * The header is a SECOND secret, distinct from the Shortcut's read key. That is
 * the whole point: a read-only Shortcut carries only OSCAR_SHARED_SECRET, so
 * that key alone can never send email as you.
 */
function canWrite(req, via, body, url) {
  if (process.env.OSCAR_ALLOW_WRITES !== '1') return false;

  // A browser session means password + a code emailed to you. That is a
  // stronger proof of identity than anything living on the phone.
  if (via === 'session') return true;

  const expected = (process.env.OSCAR_WRITE_SECRET || '').trim();
  if (!expected) return false;

  const provided =
    req.headers['x-oscar-write'] || url.searchParams.get('write') || body.writeKey || '';

  return safeEqual(provided, expected);
}

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

/**
 * Should a destructive action stop and ask first?
 *
 * The rule is about HOW the request arrived, because that is the best available
 * proxy for how the words were produced:
 *
 *   Shortcut (x-oscar-key)  → ASK. This is dictation. Speech recognition
 *                             mishears things, and there is no screen showing
 *                             you which event actually matched "Thursday".
 *   Web console, typed      → DON'T ASK. You typed it deliberately, with the
 *                             answer in front of you, and a Yes button two
 *                             inches below would just be a second click.
 *   Web console, dictated   → ASK. The console sets `dictated: true` when the
 *                             mic was used, so the microphone gets the same
 *                             protection wherever it is.
 *
 * The server cannot actually observe speech versus typing — only the client
 * knows that — so this trusts the client's own report. That's acceptable
 * precisely because it can only ever make Oscar MORE cautious than the default
 * for that route, never less: a forged `dictated: true` adds a confirmation
 * step, and omitting it on the Shortcut path changes nothing, since the route
 * itself already forces a confirmation.
 *
 * OSCAR_CONFIRM_ALWAYS=1 forces confirmation on every route, including typed
 * web input, if you'd rather have the belt and braces.
 */
function requireConfirmation(via, body, env = process.env) {
  if (env.OSCAR_CONFIRM_ALWAYS === '1') return true;
  if (body.dictated === true || body.dictated === 'true' || body.dictated === 1) return true;
  // 'key' means the Shortcut. A browser session is the typed path.
  return via === 'key';
}

/**
 * Pull coordinates out of the request.
 *
 * Shortcuts' "Get Current Location" gives you a Location variable; depending on
 * how it's wired into the JSON body you end up with flat `latitude`/`longitude`
 * fields, a nested `location` dictionary, or a "lat,lon" string. Accept all
 * three rather than making the Shortcut fragile.
 */
function readCoords(body = {}, url) {
  const candidates = [
    body,
    body.location,
    body.coords,
    { latitude: url.searchParams.get('lat'), longitude: url.searchParams.get('lon') },
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const lat = Number(candidate.latitude ?? candidate.lat);
    const lon = Number(candidate.longitude ?? candidate.lon ?? candidate.lng);
    if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) {
      return { latitude: lat, longitude: lon };
    }
  }

  // "47.6062,-122.3321" — what you get if the Location variable is dropped
  // straight into a text field.
  const pair = typeof body.location === 'string' ? body.location : body.coords;
  if (typeof pair === 'string') {
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(pair);
    if (match) return { latitude: Number(match[1]), longitude: Number(match[2]) };
  }

  return null;
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

    // GPS from the Shortcut's "Get Current Location" action. Accepts a few
    // shapes because Shortcuts can hand over a dictionary, and people wire it
    // up differently.
    const coords = readCoords(body, url);

    const writeAllowed = canWrite(req, via, body, url);
    const askFirst = requireConfirmation(via, body, process.env);

    // ---- how much machinery does this deserve? ----------------------------
    // A quick lookup answers inline in a couple of seconds. Real work becomes a
    // background job so it is not bounded by how long the caller will wait.
    const route = await routeQuestion(question, { env: process.env, mode: body.mode });
    const agentInput = {
      question,
      timeZone,
      coords,
      ip: clientIp(req),
      canWrite: writeAllowed,
      requireConfirm: askFirst,
      model: route.model,
    };

    // A mission plans itself and then carries the plan out, which means writing
    // things. Without write authority it could not even save the plan, so it is
    // quietly demoted rather than started and failed one step later.
    const wantsMission = route.mode === 'mission' && writeAllowed;
    const backgroundMode = wantsMission ? 'mission' : route.mode === 'mission' ? 'deep' : route.mode;

    if (backgroundMode !== 'fast' && isJobsConfigured() && body.async !== false) {
      const job = await createJob(
        {
          question,
          mode: backgroundMode,
          model: route.model,
          state: wantsMission
            ? createMissionState(agentInput, process.env)
            : createAgentState(agentInput, process.env),
          source,
          via,
        },
        { env: process.env }
      );

      // Fire the first step without waiting — the whole point is to answer now.
      continueJob(job.id, { env: process.env });

      const answer = wantsMission
        ? "I'll plan that out and work through it. You'll get a notification when it's done."
        : 'Working on that now. Open Oscar to watch, or check back shortly.';

      return send(res, 200, {
        ok: true,
        async: true,
        jobId: job.id,
        jobToken: createJobToken(job.id, process.env),
        status: 'queued',
        mode: backgroundMode,
        routedBy: route.via,
        // Kept so an unchanged Shortcut still shows something sensible.
        title: 'Working on it',
        answer,
        speak: answer,
        needsConfirmation: false,
        via,
        canWrite: writeAllowed,
      });
    }

    const result = await askAgent(agentInput, { env: process.env });

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

    // A destructive action is waiting on a yes/no. Hand back a signed token
    // describing exactly what was proposed.
    const pending = result.pendingConfirmation
      ? {
          needsConfirmation: true,
          confirmPrompt: result.pendingConfirmation.prompt,
          confirmToken: createConfirmToken(result.pendingConfirmation, process.env),
          confirmExpiresInSeconds: Math.floor(CONFIRM_TTL_MS / 1000),
        }
      : { needsConfirmation: false };

    return send(res, 200, {
      ok: true,
      question: String(question).trim(),
      title: result.title,
      answer: result.answer,
      detail: result.detail,
      ...pending,
      // `speak` is what you feed into a "Speak Text" action if you want it read
      // aloud: answer + detail merged.
      speak: result.detail ? `${result.answer} ${result.detail}` : result.answer,
      model: result.model,
      elapsedMs: result.elapsedMs,
      tools: result.toolsUsed,
      rounds: result.rounds,
      async: false,
      mode: route.mode,
      routedBy: route.via,
      via,
      canWrite: writeAllowed,
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
