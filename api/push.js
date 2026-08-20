/**
 * api/push.js
 * ----------------------------------------------------------------------------
 * Managing which devices get notifications.
 *
 *   GET  /api/push                              -> the public key, and whether this works
 *   POST /api/push { action: 'subscribe', … }   -> remember this browser
 *   POST /api/push { action: 'unsubscribe', … } -> forget it
 *   POST /api/push { action: 'test' }           -> send one, to prove it works
 *
 * AUTH IS SESSION-ONLY, the same rule as /api/history and for the same reason.
 * The Shortcut key sits in plain text on a phone; it is fine for asking a
 * question and not fine for registering a device that will then receive
 * everything Oscar has to say. Subscribing is a deliberate act you do while
 * signed in.
 *
 * The GET is the exception in spirit but not in rule: the public key it returns
 * is genuinely public — it ends up in the page and in every browser that
 * subscribes — but there is no reason to hand out a map of your setup to
 * anyone who asks, so it stays behind the session too.
 */

import { getSession } from '../lib/auth.js';
import { applyCors, readBody, send } from '../lib/http.js';
import {
  saveSubscription,
  removeSubscription,
  listSubscriptions,
  sendPush,
  vapidKeys,
  isPushConfigured,
  PushError,
} from '../lib/push.js';

/** A readable device name from the user agent. Best effort — it is only a label. */
function labelFor(userAgent = '') {
  const ua = String(userAgent);
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  return 'Browser';
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (!getSession(req)) {
    return send(res, 401, { ok: false, error: 'Sign in to manage notifications.' });
  }

  const keys = vapidKeys();

  if (req.method === 'GET') {
    let devices = [];
    if (isPushConfigured()) {
      devices = await listSubscriptions({}).catch(() => []);
    }
    return send(res, 200, {
      ok: true,
      configured: isPushConfigured(),
      // The client needs this to call pushManager.subscribe().
      publicKey: keys ? keys.publicKey : null,
      devices: devices.map((d) => ({
        label: d.label,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
      })),
      hint: isPushConfigured()
        ? undefined
        : 'Run `npm run vapid`, add both keys to Vercel, and redeploy.',
    });
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use GET or POST.' });

  if (!isPushConfigured()) {
    return send(res, 503, {
      ok: false,
      error: 'Notifications are not configured. Run `npm run vapid` and add the keys to Vercel.',
    });
  }

  try {
    const body = await readBody(req);
    const action = String(body.action || 'subscribe');

    if (action === 'subscribe') {
      const incoming = body.subscription || body;
      // The browser nests the keys; accept either shape so the client stays simple.
      const saved = await saveSubscription(
        {
          endpoint: incoming.endpoint,
          p256dh: (incoming.keys && incoming.keys.p256dh) || incoming.p256dh,
          auth: (incoming.keys && incoming.keys.auth) || incoming.auth,
          label: body.label || labelFor(req.headers['user-agent']),
        },
        {}
      );
      return send(res, 200, { ok: true, subscribed: true, label: saved.label });
    }

    if (action === 'unsubscribe') {
      const endpoint = String((body.subscription && body.subscription.endpoint) || body.endpoint || '');
      if (!endpoint) return send(res, 400, { ok: false, error: 'No endpoint given.' });
      await removeSubscription(endpoint, {});
      return send(res, 200, { ok: true, unsubscribed: true });
    }

    if (action === 'test') {
      const devices = await listSubscriptions({});
      if (!devices.length) {
        return send(res, 200, { ok: false, error: 'No devices are subscribed yet.' });
      }

      const results = await Promise.all(
        devices.map((device) =>
          sendPush(
            device,
            {
              title: 'Oscar',
              body: 'Notifications are working.',
              tag: 'oscar-test',
            },
            {}
          ).catch((err) => ({ ok: false, error: (err && err.message) || 'send failed' }))
        )
      );

      const sent = results.filter((r) => r.ok).length;
      return send(res, 200, {
        ok: sent > 0,
        sent,
        failed: results.length - sent,
        errors: results.filter((r) => !r.ok).map((r) => r.error).slice(0, 3),
      });
    }

    return send(res, 400, { ok: false, error: `Unknown action "${action}".` });
  } catch (err) {
    const status = err instanceof PushError ? err.status : 500;
    const message = err instanceof PushError ? err.message : 'That notification request failed.';
    console.error('[oscar] push:', err);
    return send(res, status, { ok: false, error: message });
  }
}
