/**
 * lib/http.js
 * ----------------------------------------------------------------------------
 * Small helpers shared by the API routes, so request parsing and JSON replies
 * behave identically everywhere.
 */

const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Vercel usually parses JSON bodies for us, but not always (and never under
 * plain `node:http`), so handle every shape. A body that isn't JSON is returned
 * as `{ question: <raw text> }` — handy if you'd rather not build a dictionary
 * inside Shortcuts.
 */
export async function readBody(req) {
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
    if (size > MAX_BODY_BYTES) throw new HttpError('Request body too large.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return { question: text };
  }
}

export function send(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(payload));
}

/**
 * CORS, deliberately narrow.
 *
 * Once a login cookie exists, blindly reflecting `Origin` back with
 * `allow-credentials: true` would let ANY website make authenticated calls with
 * your session — so the origin is only echoed when it matches this deployment's
 * own host, or an entry in OSCAR_ALLOWED_ORIGINS (comma separated).
 *
 * The iOS Shortcut is not a browser and never sends an Origin header, so none
 * of this affects it.
 */
export function applyCors(req, res, env = process.env) {
  const origin = req.headers && req.headers.origin;
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-oscar-key');

  if (!origin) return;

  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
  const allowed = new Set(
    String(env.OSCAR_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  if (host) {
    allowed.add(`https://${host}`);
    allowed.add(`http://${host}`); // local `vercel dev`
  }

  if (allowed.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-credentials', 'true');
  }
}

export function clientIp(req) {
  const header = (req.headers && req.headers['x-forwarded-for']) || '';
  return String(header).split(',')[0].trim() || 'unknown';
}
