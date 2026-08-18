/**
 * lib/confirm.js
 * ----------------------------------------------------------------------------
 * Two-phase confirmation for destructive actions.
 *
 *   you:    "delete the event on Thursday"
 *   Oscar:  looks it up, does NOT delete, replies
 *           "Delete 'Dentist' on Thu 20 Aug at 2:00 PM?"  + a signed token
 *   you:    tap Yes
 *   phone:  POST /api/confirm with that token
 *   Oscar:  verifies, deletes, confirms
 *
 * WHY A SIGNED TOKEN RATHER THAN A SESSION
 *
 * The server keeps no state between requests, so "the thing you just agreed to"
 * has to travel with the request. An HMAC-signed token does that: it carries the
 * exact tool name and arguments, and the signature means the phone cannot alter
 * either. A token authorising "delete event abc123" cannot be edited into
 * "delete event xyz789" — changing one byte invalidates the signature.
 *
 * It is signed with OSCAR_SESSION_SECRET, so rotating that value instantly
 * invalidates every outstanding confirmation as well as every login.
 *
 * KNOWN LIMIT, STATED PLAINLY
 *
 * Because there is no store, a token cannot be enforced as strictly single-use.
 * Within its 5-minute life it could be replayed. For deletes that is close to
 * harmless — deleting an already-deleted event fails with a 404/410 — and the
 * alternative is a database dependency on the critical path. If that tradeoff
 * ever stops being acceptable, the fix is a one-row insert in Supabase keyed on
 * the token id.
 */

import { signToken, verifyToken, sessionSecret } from './auth.js';

/** Long enough to read a notification and tap; short enough to be useless later. */
export const CONFIRM_TTL_MS = 5 * 60 * 1000;

export class ConfirmError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ConfirmError';
    this.status = status;
  }
}

/**
 * Mint a token for one specific pending action.
 *
 * @param {{tool: string, args: object, prompt: string}} pending
 * @returns {string}
 */
export function createConfirmToken(pending, env = process.env, now = Date.now()) {
  return signToken(
    {
      t: 'confirm',
      tool: pending.tool,
      args: pending.args || {},
      // Carried so /api/confirm can echo back what was agreed to, rather than
      // re-deriving it and risking a mismatch with what you actually saw.
      prompt: pending.prompt,
      iat: now,
      exp: now + CONFIRM_TTL_MS,
    },
    sessionSecret(env)
  );
}

/**
 * @returns {{tool: string, args: object, prompt: string}}
 * @throws {ConfirmError} with a message safe to show the user
 */
export function readConfirmToken(token, env = process.env) {
  if (!token || typeof token !== 'string') {
    throw new ConfirmError('No confirmation token was sent.');
  }

  const payload = verifyToken(token, sessionSecret(env));

  // verifyToken returns null for forged, malformed AND expired tokens alike.
  // Expiry is by far the likeliest, so lead with that in the message.
  if (!payload || payload.t !== 'confirm') {
    throw new ConfirmError(
      'That confirmation has expired or is not valid. Ask again and confirm within five minutes.',
      401
    );
  }

  return { tool: payload.tool, args: payload.args || {}, prompt: payload.prompt };
}

/**
 * Did the user actually say yes?
 *
 * Shortcuts is loose about types — a menu result arrives as the text "Yes", a
 * toggle as 1 or true, and JSON booleans come through as either. Accept the
 * lot, but default to NO. Anything unrecognised is treated as a refusal, which
 * is the only safe direction for a delete.
 */
export function isAffirmative(value) {
  if (value === true || value === 1) return true;
  const text = String(value ?? '').trim().toLowerCase();
  return ['yes', 'y', 'true', '1', 'ok', 'okay', 'confirm', 'delete', 'do it'].includes(text);
}
