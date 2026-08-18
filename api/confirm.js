/**
 * api/confirm.js
 * ----------------------------------------------------------------------------
 * Phase two of a destructive action.
 *
 *   POST /api/confirm
 *   headers: x-oscar-key, x-oscar-write
 *   body:    { "token": "<from /api/ask>", "confirm": "Yes" }
 *
 * The token carries the exact tool and arguments the user was shown, signed so
 * neither can be altered. This endpoint verifies it, re-checks that the caller
 * still has write authority, and only then executes.
 *
 * WHY WRITE AUTHORITY IS CHECKED AGAIN
 *
 * The token proves *what* was agreed to, not *who* is asking now. Without a
 * second check, a token captured from a write-enabled request could be replayed
 * by anything holding only the read key. Both must hold: a valid token, and a
 * caller entitled to write.
 *
 * Answering "No" is a normal, successful outcome — it returns 200 with a
 * cancellation message, so the Shortcut shows "Cancelled" rather than an error.
 */

import { getSession, safeEqual, penaltyDelay } from '../lib/auth.js';
import { applyCors, readBody, send, clientIp } from '../lib/http.js';
import { readConfirmToken, isAffirmative, ConfirmError } from '../lib/confirm.js';
import { runTool, getTool } from '../lib/tools/index.js';
import { logConversation, conversationRow } from '../lib/db.js';

function authenticate(req, url, body) {
  if (getSession(req)) return 'session';
  const expected = process.env.OSCAR_SHARED_SECRET;
  if (!expected) return null;
  const provided =
    req.headers['x-oscar-key'] || url.searchParams.get('key') || body.key || '';
  return safeEqual(provided, expected) ? 'key' : null;
}

function hasWriteAuthority(req, via, body, url) {
  if (process.env.OSCAR_ALLOW_WRITES !== '1') return false;
  if (via === 'session') return true;
  const expected = (process.env.OSCAR_WRITE_SECRET || '').trim();
  if (!expected) return false;
  const provided =
    req.headers['x-oscar-write'] || url.searchParams.get('write') || body.writeKey || '';
  return safeEqual(provided, expected);
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, title: 'Oscar failed', answer: 'Use POST to confirm.' });
  }

  const startedAt = Date.now();

  try {
    const url = new URL(req.url, 'http://localhost');
    const body = await readBody(req);

    const via = authenticate(req, url, body);
    if (!via) {
      await penaltyDelay(250);
      return send(res, 401, {
        ok: false,
        title: 'Oscar failed',
        answer: 'Not authorised.',
        speak: 'Not authorised.',
      });
    }

    // ---- did they say yes? -----------------------------------------------
    // Checked before the token, so tapping No never touches Google at all.
    if (!isAffirmative(body.confirm ?? body.answer ?? body.choice)) {
      return send(res, 200, {
        ok: true,
        cancelled: true,
        title: 'Cancelled',
        answer: 'Cancelled — nothing was changed.',
        speak: 'Cancelled. Nothing was changed.',
      });
    }

    const pending = readConfirmToken(body.token, process.env);

    if (!hasWriteAuthority(req, via, body, url)) {
      return send(res, 403, {
        ok: false,
        title: 'Oscar failed',
        answer:
          'That confirmation is valid, but this request has no permission to change anything. ' +
          'Use the write-enabled Shortcut.',
        speak: 'No permission to make that change.',
      });
    }

    const tool = getTool(pending.tool);
    if (!tool) {
      return send(res, 400, {
        ok: false,
        title: 'Oscar failed',
        answer: 'That confirmation refers to something Oscar no longer knows how to do.',
      });
    }

    // `confirmed: true` is what lets the tool past its own gate in runTool.
    const outcome = await runTool(pending.tool, pending.args, {
      env: process.env,
      timeZone: body.tz || body.timeZone || undefined,
      ip: clientIp(req),
      canWrite: true,
      confirmed: true,
    });

    if (outcome.error) {
      return send(res, 502, {
        ok: false,
        title: 'Oscar failed',
        answer: outcome.error,
        speak: outcome.error,
      });
    }

    const answer =
      (outcome.result && outcome.result.confirmation) || 'Done.';

    await logConversation(
      conversationRow({
        question: `[confirmed] ${pending.prompt}`,
        result: {
          title: 'Done',
          answer,
          detail: '',
          model: null,
          elapsedMs: outcome.elapsedMs,
          toolsUsed: [pending.tool],
        },
        status: 200,
        via,
        source: body.source || (via === 'key' ? 'shortcut' : 'console'),
        totalMs: Date.now() - startedAt,
      })
    );

    return send(res, 200, {
      ok: true,
      done: true,
      title: 'Done',
      answer,
      speak: answer,
      tool: pending.tool,
    });
  } catch (err) {
    const status = err instanceof ConfirmError ? err.status : 500;
    const message =
      err instanceof ConfirmError ? err.message : 'Something broke while confirming.';
    if (status >= 500) console.error('[oscar] confirm:', err);

    return send(res, status, {
      ok: false,
      title: 'Oscar failed',
      answer: message,
      speak: message,
    });
  }
}
