/**
 * lib/push.js
 * ----------------------------------------------------------------------------
 * Notifications to your phone, without the Shortcut.
 *
 * WHAT A WEB PUSH ACTUALLY IS
 *
 * The browser hands you an `endpoint` belonging to its own push service —
 * Apple's for Safari, Google's for Chrome — plus two keys. You POST an
 * encrypted blob to that endpoint; the push service relays it to the device
 * without being able to read it, and the service worker decrypts and displays
 * it. Apple never sees the text of your notification, which is the whole point
 * of the ceremony below.
 *
 * WHY THIS IS HAND-ROLLED
 *
 * The obvious move is `npm i web-push`. But this project has no runtime
 * dependencies at all — you deploy it by pushing files, and `npm install` is
 * never needed. Adding one package for this would end that property for the
 * sake of about ninety lines. Node ships everything required: ECDH, HKDF,
 * AES-128-GCM and ECDSA are all in node:crypto.
 *
 * The two specs implemented here, if you need to check this against something:
 *
 *   RFC 8291 — Message Encryption for Web Push  (the key agreement)
 *   RFC 8188 — Encrypted Content-Encoding       (the aes128gcm framing)
 *   RFC 8292 — VAPID                            (proving who is sending)
 *
 * None of it is negotiable or version-dependent, which is why hand-rolling it
 * is reasonable: these bytes are the same today as they were in 2017.
 */

import crypto from 'node:crypto';
import { dbRequest, isConfigured } from './db.js';

/** RFC 8188 record size. Bigger than any notification we send, so there is one record. */
const RECORD_SIZE = 4096;

/** How long a signed VAPID token is good for. The spec caps this at 24 hours. */
const TOKEN_TTL_S = 12 * 60 * 60;

/** How long the push service should hold a message for a device that is offline. */
export const DEFAULT_TTL_S = 4 * 60 * 60;

/** Consecutive failures before a subscription is written off. */
const MAX_FAILURES = 3;

export class PushError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'PushError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ base64url */

export function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text) {
  return Buffer.from(String(text || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/* ---------------------------------------------------------------------- keys */

/** @returns {{publicKey: string, privateKey: string, subject: string}|null} */
export function vapidKeys(env = process.env) {
  const publicKey = (env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (env.VAPID_PRIVATE_KEY || '').trim();
  if (!publicKey || !privateKey) return null;

  // Falls back to the owner address so a working setup needs one fewer variable.
  // VAPID wants a contact for whoever operates the sender; a push service that
  // sees something odd is supposed to be able to reach a human.
  const contact = (env.VAPID_SUBJECT || env.OSCAR_OWNER_EMAIL || '').trim();
  const subject = contact.startsWith('http') || contact.startsWith('mailto:')
    ? contact
    : `mailto:${contact || 'oscar@example.com'}`;

  return { publicKey, privateKey, subject };
}

export function isPushConfigured(env = process.env) {
  return vapidKeys(env) !== null && isConfigured(env);
}

/**
 * A P-256 keypair as a JWK, which is the one format node:crypto will import
 * from raw bytes. Web push keys are exchanged as raw base64url everywhere —
 * an uncompressed point (0x04 ‖ X ‖ Y) and a 32-byte scalar — so this is the
 * bridge between what the ecosystem hands you and what Node will sign with.
 */
function privateJwk(publicKeyB64, privateKeyB64) {
  const pub = fromB64url(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new PushError('VAPID_PUBLIC_KEY is not an uncompressed P-256 point.');
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(pub.subarray(1, 33)),
    y: b64url(pub.subarray(33, 65)),
    d: b64url(fromB64url(privateKeyB64)),
  };
}

/* ---------------------------------------------------------------------- HKDF */

/**
 * HKDF, single-block only.
 *
 * Every derivation web push needs is 32 bytes or fewer, so the counter never
 * goes past 0x01 and the loop RFC 5869 describes collapses to one HMAC. Guarded
 * rather than assumed, because a silent truncation here would produce keys that
 * look fine and decrypt to nothing.
 */
function hkdf(salt, ikm, info, length) {
  if (length > 32) throw new PushError('hkdf: this implementation only does one block.');
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}

/* ----------------------------------------------------------------- encryption */

/**
 * Encrypt a payload so that only the subscribed browser can read it.
 *
 * @param {string} payload            the JSON the service worker will receive
 * @param {{p256dh: string, auth: string}} subscription
 * @returns {Buffer} the aes128gcm body, ready to POST
 */
export function encryptPayload(payload, subscription) {
  const uaPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);

  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new PushError('That subscription\'s p256dh key is not a P-256 point.');
  }
  if (authSecret.length !== 16) {
    throw new PushError('That subscription\'s auth secret is the wrong length.');
  }

  // A fresh ephemeral keypair per message. Reusing one would let anyone who
  // ever recovered it decrypt every notification you had sent.
  const ephemeral = crypto.createECDH('prime256v1');
  ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey();
  const sharedSecret = ephemeral.computeSecret(uaPublic);

  // RFC 8291 §3.4. Binding both public keys into the info string is what stops
  // a shared secret from one conversation being replayed into another.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // 0x02 is the RFC 8188 delimiter meaning "last record". 0x01 would mean
  // another record follows, and the browser would sit waiting for one.
  const padded = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // header = salt(16) ‖ record size(4) ‖ key length(1) ‖ the ephemeral key
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, ciphertext]);
}

/* --------------------------------------------------------------------- VAPID */

/**
 * The signed token that says "this really is Oscar sending".
 *
 * The audience is the push service's ORIGIN, not the full endpoint. Getting
 * that wrong is the classic VAPID mistake: the token verifies as well-formed
 * and the service rejects it with a 401 that says nothing useful.
 */
export function vapidAuthorization(endpoint, keys, now = Date.now()) {
  const audience = new URL(endpoint).origin;

  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(now / 1000) + TOKEN_TTL_S,
      sub: keys.subject,
    })
  );
  const signingInput = `${header}.${claims}`;

  const privateKey = crypto.createPrivateKey({
    key: privateJwk(keys.publicKey, keys.privateKey),
    format: 'jwk',
  });

  // ieee-p1363 gives the raw r‖s pair JWS wants. Node's default is DER, which
  // is a perfectly valid ECDSA signature that every push service will reject.
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`;
}

/* ---------------------------------------------------------------------- send */

/**
 * Deliver one notification to one subscription.
 *
 * @returns {Promise<{ok: boolean, status: number, gone?: boolean, error?: string}>}
 */
export async function sendPush(subscription, notification, deps = {}) {
  const env = deps.env || process.env;
  const keys = vapidKeys(env);
  if (!keys) throw new PushError('No VAPID keys are configured.', 503);

  const doFetch = deps.fetchImpl || globalThis.fetch;
  const body = encryptPayload(JSON.stringify(notification), subscription);

  let res;
  try {
    res = await doFetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(subscription.endpoint, keys, deps.now || Date.now()),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(notification.ttl || DEFAULT_TTL_S),
        urgency: notification.urgency || 'normal',
      },
      body,
    });
  } catch (err) {
    // The network, not the subscription. Worth retrying later, so not `gone`.
    return { ok: false, status: 0, error: (err && err.message) || 'Could not reach the push service.' };
  }

  // 404 and 410 are the push service saying this subscription is dead for good
  // — the app was deleted, or permission was revoked. Anything else might be a
  // bad afternoon, and is not grounds for forgetting the device.
  if (res.status === 404 || res.status === 410) {
    return { ok: false, status: res.status, gone: true, error: 'That subscription no longer exists.' };
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* the status is enough */
    }
    return { ok: false, status: res.status, error: detail || `Push service returned ${res.status}.` };
  }

  return { ok: true, status: res.status };
}

/* -------------------------------------------------------------- subscriptions */

function tidy(row) {
  if (!row) return null;
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    label: row.label || undefined,
    failures: row.failures || 0,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || undefined,
    expiredAt: row.expired_at || undefined,
  };
}

/**
 * Store a subscription, or refresh one we already had.
 *
 * The endpoint is the identity — re-subscribing the same browser yields the
 * same endpoint — so this upserts on it. That also revives a subscription
 * previously marked expired, which is exactly right: the user just granted
 * permission again.
 */
export async function saveSubscription(subscription, deps = {}) {
  if (!isConfigured(deps.env || process.env)) {
    throw new PushError('No database is configured, so subscriptions cannot be stored.', 503);
  }

  const endpoint = String(subscription.endpoint || '').trim();
  const p256dh = String(subscription.p256dh || '').trim();
  const auth = String(subscription.auth || '').trim();

  if (!endpoint || !p256dh || !auth) throw new PushError('That subscription is incomplete.', 400);
  if (!/^https:\/\//i.test(endpoint)) throw new PushError('A push endpoint must be https.', 400);

  const row = {
    endpoint: endpoint.slice(0, 2000),
    p256dh,
    auth,
    label: subscription.label ? String(subscription.label).slice(0, 100) : null,
    failures: 0,
    expired_at: null,
    last_used_at: null,
  };

  const result = await dbRequest(
    'push_subscriptions?on_conflict=endpoint',
    {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row),
    },
    deps
  );
  if (!result.ok) throw new PushError(`Could not save the subscription: ${result.error || result.status}`);

  const saved = Array.isArray(result.data) ? result.data[0] : result.data;
  return tidy(saved) || tidy(row);
}

export async function removeSubscription(endpoint, deps = {}) {
  const result = await dbRequest(
    `push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
    { method: 'DELETE', headers: { prefer: 'return=minimal' } },
    deps
  );
  if (!result.ok) throw new PushError(`Could not remove the subscription: ${result.error || result.status}`);
  return true;
}

/** Every device that should still be receiving notifications. */
export async function listSubscriptions(deps = {}) {
  const result = await dbRequest(
    'push_subscriptions?select=*&expired_at=is.null&order=created_at.desc&limit=50',
    { method: 'GET' },
    deps
  );
  if (!result.ok) throw new PushError(`Could not list subscriptions: ${result.error || result.status}`);
  return (Array.isArray(result.data) ? result.data : []).map(tidy);
}

async function recordOutcome(subscription, outcome, deps = {}) {
  const patch = outcome.ok
    ? { last_used_at: new Date().toISOString(), failures: 0 }
    : { failures: (subscription.failures || 0) + 1 };

  // Written off either because the service says it is gone, or because it has
  // failed enough times that something is genuinely wrong with it.
  if (outcome.gone || (!outcome.ok && patch.failures >= MAX_FAILURES)) {
    patch.expired_at = new Date().toISOString();
  }

  await dbRequest(
    `push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`,
    { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(patch) },
    deps
  ).catch(() => {});
}

/**
 * Send one notification to every device.
 *
 * NEVER THROWS. A notification is the last step of something that already
 * worked — a finished job, an answered question — and failing to tell you about
 * it must not turn a successful run into a failed one. Errors come back in the
 * return value for logging, and the caller is free to ignore them.
 */
export async function notifyAll(notification, deps = {}) {
  const env = deps.env || process.env;
  if (!isPushConfigured(env)) return { sent: 0, failed: 0, skipped: true };

  let subscriptions = [];
  try {
    subscriptions = await listSubscriptions(deps);
  } catch (err) {
    console.error(`[oscar] could not list push subscriptions: ${err && err.message}`);
    return { sent: 0, failed: 0, error: (err && err.message) || 'lookup failed' };
  }
  if (!subscriptions.length) return { sent: 0, failed: 0, noDevices: true };

  const results = await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        const outcome = await sendPush(subscription, notification, deps);
        await recordOutcome(subscription, outcome, deps);
        return outcome;
      } catch (err) {
        return { ok: false, status: 0, error: (err && err.message) || 'send failed' };
      }
    })
  );

  return {
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    errors: results.filter((r) => !r.ok).map((r) => r.error).slice(0, 3),
  };
}
