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
 * Errors deliberately return the same shape as success, because the Shortcut
 * reads `answer` and shows it in a notification either way. That way a failure
 * shows up on your lock screen as readable text instead of silently doing
 * nothing.
 *
 * GET is also supported (`/api/ask?q=...&key=...`) purely so you can sanity
 * check the deployment from a browser.
 */

import { askAgent, AgentError } from '../lib/agent.js';

const MAX_BODY_BYTES = 64 * 1024;

/** Constant-time-ish string compare so the secret can't be probed by timing. */
function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Vercel usually parses the body for us; fall back to reading the stream. */
async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const asText = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    try {
      return JSON.parse(asText);
    } catch {
      return { question: asText };
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AgentError('Request body too large.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    // Plain-text body: treat the whole thing as the question. Handy if you'd
    // rather not build a dictionary inside Shortcuts.
    return { question: text };
  }
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  // CORS, so the bundled web console (and any other page you own) can call this.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-oscar-key');

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

  try {
    const url = new URL(req.url, 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : {};

    // ---- auth -------------------------------------------------------------
    const expected = process.env.OSCAR_SHARED_SECRET;
    if (expected) {
      const provided =
        req.headers['x-oscar-key'] ||
        url.searchParams.get('key') ||
        body.key ||
        (typeof req.headers.authorization === 'string'
          ? req.headers.authorization.replace(/^Bearer\s+/i, '')
          : '');
      if (!safeEqual(provided, expected)) {
        return send(res, 401, {
          ok: false,
          title: 'Oscar failed',
          answer: 'That key is not right. Check the x-oscar-key header in the Shortcut.',
        });
      }
    }

    // ---- input ------------------------------------------------------------
    const question =
      body.question ||
      body.q ||
      body.text ||
      url.searchParams.get('q') ||
      url.searchParams.get('question') ||
      '';

    const timeZone =
      body.tz || body.timeZone || url.searchParams.get('tz') || undefined;

    const result = await askAgent({ question, timeZone }, { env: process.env });

    return send(res, 200, {
      ok: true,
      question: String(question).trim(),
      title: result.title,
      answer: result.answer,
      detail: result.detail,
      // `speak` is what you feed into a "Speak Text" action if you want it read
      // aloud: title + answer merged, since the title carries context.
      speak: result.detail ? `${result.answer} ${result.detail}` : result.answer,
      model: result.model,
      elapsedMs: result.elapsedMs,
    });
  } catch (err) {
    const status = err instanceof AgentError ? err.status : 500;
    const message =
      err instanceof AgentError ? err.message : 'Something broke on the server.';

    if (status >= 500) console.error('[oscar] ', err);

    return send(res, status, {
      ok: false,
      title: 'Oscar failed',
      answer: err && err.detail ? `${message} (${err.detail})` : message,
      detail: '',
      speak: message,
    });
  }
}
