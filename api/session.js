/**
 * api/session.js
 * ----------------------------------------------------------------------------
 * GET /api/session — "am I logged in?"
 *
 * The page calls this on load to decide whether to show the login card or the
 * console. It reads the HttpOnly cookie, which page scripts cannot read
 * themselves — that's the point of HttpOnly.
 */

import { getSession, maskEmail } from '../lib/auth.js';
import { applyCors, send } from '../lib/http.js';

export default function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const session = getSession(req);

  return send(res, 200, {
    ok: true,
    authed: Boolean(session),
    email: session ? maskEmail(session.sub) : null,
    expiresAt: session ? new Date(session.exp).toISOString() : null,
  });
}
