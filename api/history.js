/**
 * api/history.js
 * ----------------------------------------------------------------------------
 * GET /api/history?limit=25&q=egg
 * GET /api/history?conversation=<uuid>     one thread, in the order it happened
 *
 * Reads back what has been logged.
 *
 * NOTE THE AUTH RULE, which is stricter than /api/ask on purpose: this endpoint
 * accepts ONLY a login session, never the Shortcut's `x-oscar-key`. That key
 * sits in plain text inside a Shortcut on your phone, so it's the weaker
 * credential — fine for asking a question, not fine for reading back everything
 * you've ever asked. Browsing history requires the password plus an emailed
 * code.
 */

import { getSession } from '../lib/auth.js';
import { applyCors, send } from '../lib/http.js';
import { recentConversations, isConfigured } from '../lib/db.js';

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') {
    return send(res, 405, { ok: false, error: 'Use GET.' });
  }

  if (!getSession(req)) {
    return send(res, 401, { ok: false, error: 'Sign in to view history.' });
  }

  if (!isConfigured()) {
    return send(res, 200, {
      ok: true,
      configured: false,
      rows: [],
      error: 'No database is configured, so nothing is being logged.',
    });
  }

  const url = new URL(req.url, 'http://localhost');

  const result = await recentConversations({
    limit: url.searchParams.get('limit'),
    search: url.searchParams.get('q'),
    before: url.searchParams.get('before'),
    // ?conversation=<uuid> reads one thread, oldest turn first — that is how
    // the console reopens a back-and-forth you had earlier.
    conversation: url.searchParams.get('conversation'),
  });

  if (!result.ok) {
    return send(res, 502, {
      ok: false,
      configured: true,
      rows: [],
      error: `Could not read the log: ${result.error}`,
    });
  }

  return send(res, 200, { ok: true, configured: true, rows: result.rows });
}
