/**
 * lib/settings.js
 * ----------------------------------------------------------------------------
 * Settings that have to be true everywhere at once.
 *
 * public/app.js already has settings, and they live in localStorage, which is
 * right for what they are: they change what the screen shows and nothing else.
 * This file is for the other kind — a choice that has to hold when the request
 * came from a Shortcut on a phone, from a background job running on a server
 * you are not watching, or from a laptop polling for work at three in the
 * morning. None of those can read your browser's storage, so the answer lives
 * in the database instead.
 *
 * THERE IS ONLY ONE SETTING HERE SO FAR: HOW MUCH OSCAR ASKS
 *
 *   none         nothing asks. Oscar deletes, sends and runs on your word alone.
 *   destructive  the irreversible things ask first — deleting, sending, and
 *                whatever the laptop's own policy calls destructive. (default)
 *   all          everything that CHANGES something asks first.
 *
 * Looking things up never asks, at any level. A confirmation for "what's the
 * weather" would train you to tap yes without reading, which is precisely how
 * a confirmation stops being a safeguard.
 *
 * THE NEW NOTIFICATION LEVEL SETTING
 *
 *   all clear on everything, no confirmation  push notifications are sent but never shown; destructive commands proceed immediately
 *   confirmation on only destructive commands  push notifications for destructive actions (delete email, send email, run pwsh command) require user response
 *   confirmation on all commands              every push notification requires a response before the action proceeds
 *
 * This setting controls whether push notifications are merely informational or actually block until answered.
 */

import { dbRequest, isConfigured } from './db.js';
import { CONFIRM_MODES } from './shell-policy.js';

export { CONFIRM_MODES as CONFIRM_LEVELS };

/** The middle setting. Chosen as the default because the other two are opinions. */
export const DEFAULT_CONFIRM_LEVEL = 'destructive';

/** The row this lives in. One table, keyed by name, so the next setting is free. */
const CONFIRM_KEY = 'confirm_level';

/** The new notification level setting key. */
const NOTIFICATION_LEVEL_KEY = 'notification_level';

/**
 * How long a level read is reused before going back to the database.
 *
 * The runner asks on every poll and an agent asks on every tool call, so
 * without this a single mission would spend hundreds of round trips confirming
 * a value that changes about twice a year. Ten seconds is short enough that
 * changing the dropdown feels immediate and long enough that the traffic
 * disappears.
 *
 * Serverless makes this weaker than it looks — each instance has its own cache
 * and they expire at different moments — which is fine for a preference and
 * would not be for a permission. Note the direction of the risk: a stale cache
 * can leave Oscar asking when you have just said he needn't, for a few seconds.
 * It cannot leave him silent when you have just asked to be asked, because the
 * value it falls back to is the stricter one.
 */
const CACHE_MS = 10000;

let cached = null;

/**
 * Forget the cached level. Called after a write, and by the tests.
 *
 * Clears every cached setting, not just the confirm level. A test that resets
 * one and inherits another from the test before it fails in a way that is very
 * hard to read, so the reset is deliberately all-or-nothing.
 */
export function clearSettingsCache() {
  cached = null;
  clearBackgroundCatchingCache();
}

/** @returns {'none'|'destructive'|'all'} the level, or the default for anything else. */
export function normalizeConfirmLevel(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return CONFIRM_MODES.includes(text) ? text : DEFAULT_CONFIRM_LEVEL;
}

/**
 * The level when there is nothing to read: the environment, then the default.
 *
 * Exported because plenty of code paths hold an env and no database — the
 * synchronous helpers in lib/tools/index.js among them — and they should get
 * the same answer as everyone else rather than inventing their own.
 */
export function confirmLevelFromEnv(env = process.env) {
  return normalizeConfirmLevel(env.OSCAR_CONFIRM_LEVEL);
}

/**
 * What you chose, from wherever it is written down.
 *
 * Never throws and never rejects: a settings read on the critical path of every
 * tool call has no business being able to fail a request. A database that is
 * down means the environment's answer, which means the default, which means
 * Oscar asks about destructive things — the same as it did before you had a
 * database at all.
 *
 * @returns {Promise<'none'|'destructive'|'all'>}
 */
export async function getConfirmLevel(deps = {}) {
  const env = deps.env || process.env;

  if (cached && Date.now() < cached.until) return cached.level;
  if (!isConfigured(env)) return confirmLevelFromEnv(env);

  const result = await dbRequest(
    `settings?key=eq.${encodeURIComponent(CONFIRM_KEY)}&select=value&limit=1`,
    { method: 'GET' },
    deps
  ).catch(() => ({ ok: false }));

  // No row is not an error — it is a deployment where nobody has touched the
  // dropdown yet. Fall through to the environment, and cache that too so a
  // fresh install is not one query per tool call.
  const row = result.ok && Array.isArray(result.data) ? result.data[0] : null;
  const level = row ? normalizeConfirmLevel(row.value) : confirmLevelFromEnv(env);

  // A failed read is deliberately NOT cached. A blip should cost one query, not
  // ten seconds of a level you did not choose.
  if (result.ok) cached = { level, until: Date.now() + CACHE_MS };
  return level;
}

export class SettingsError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
  }
}

/** The notification level setting values. */
export const NOTIFICATION_LEVELS = [
  'all clear on everything, no confirmation',
  'confirmation on only destructive commands',
  'confirmation on all commands',
];

/** @returns {'info'|'destructive'|'all'} the notification level, or 'info' for anything else. */
export function normalizeNotificationLevel(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  const normalized = NOTIFICATION_LEVELS.find((level) => text.includes(level)) || 'info';
  return normalized;
}

/**
 * The notification level when there is nothing to read: the default.
 *
 * @returns {'info'|'destructive'|'all'}
 */
export function notificationLevelFromDefault() {
  return 'info';
}

let notificationCached = null;

/** Forget the cached notification level. Called after a write, and by the tests. */
export function clearNotificationCache() {
  notificationCached = null;
}

/**
 * The notification level from wherever it is written down.
 *
 * Never throws and never rejects: a settings read on the critical path of every
 * tool call has no business being able to fail a request. A database that is
 * down means the default — notifications are informational until explicitly enabled.
 *
 * @returns {Promise<'info'|'destructive'|'all'>}
 */
export async function getNotificationLevel(deps = {}) {
  const env = deps.env || process.env;

  if (notificationCached && Date.now() < notificationCached.until) return notificationCached.level;
  if (!isConfigured(env)) return notificationLevelFromDefault();

  const result = await dbRequest(
    `settings?key=eq.${encodeURIComponent(NOTIFICATION_LEVEL_KEY)}&select=value&limit=1`,
    { method: 'GET' },
    deps
  ).catch(() => ({ ok: false }));

  // No row is not an error — it is a deployment where nobody has touched the
  // dropdown yet. Fall through to the default, and cache that too so a
  // fresh install is not one query per tool call.
  const row = result.ok && Array.isArray(result.data) ? result.data[0] : null;
  const level = row ? normalizeNotificationLevel(row.value) : notificationLevelFromDefault();

  // A failed read is deliberately NOT cached. A blip should cost one query, not
  // ten seconds of a level you did not choose.
  if (result.ok) notificationCached = { level, until: Date.now() + CACHE_MS };
  return level;
}

/**
 * Write the notification level down.
 *
 * Upsert rather than insert-or-update, so this is one round trip and cannot
 * race with itself into two rows for the same key.
 *
 * @param {'info'|'destructive'|'all'} level
 */
export async function setNotificationLevel(level, deps = {}) {
  const env = deps.env || process.env;
  const wanted = String(level == null ? '' : level).trim().toLowerCase();

  // Unlike reading, writing is strict. A typo here would silently store the
  // default and then show you a dropdown that disagrees with what you clicked.
  if (!NOTIFICATION_LEVELS.includes(wanted)) {
    throw new SettingsError(`"${level}" is not one of ${NOTIFICATION_LEVELS.join(', ')}.`, 400);
  }
  if (!isConfigured(env)) {
    throw new SettingsError(
      'No database is configured, so there is nowhere to save this. Set the notification level in environment instead.',
      503
    );
  }

  const result = await dbRequest(
    'settings',
    {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ key: NOTIFICATION_LEVEL_KEY, value: wanted, updated_at: new Date().toISOString() }),
    },
    deps
  );

  if (!result.ok) {
    throw new SettingsError(`Could not save the setting: ${result.error || result.status}`);
  }

  clearNotificationCache();
  return wanted;
}

/**
 * Write the level down.
 *
 * Upsert rather than insert-or-update, so this is one round trip and cannot
 * race with itself into two rows for the same key.
 *
 * @param {'none'|'destructive'|'all'} level
 */
export async function setConfirmLevel(level, deps = {}) {
  const env = deps.env || process.env;
  const wanted = String(level == null ? '' : level).trim().toLowerCase();

  // Unlike reading, writing is strict. A typo here would silently store the
  // default and then show you a dropdown that disagrees with what you clicked.
  if (!CONFIRM_MODES.includes(wanted)) {
    throw new SettingsError(`"${level}" is not one of ${CONFIRM_MODES.join(', ')}.`, 400);
  }
  if (!isConfigured(env)) {
    throw new SettingsError(
      'No database is configured, so there is nowhere to save this. Set OSCAR_CONFIRM_LEVEL instead.',
      503
    );
  }

  const result = await dbRequest(
    'settings',
    {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ key: CONFIRM_KEY, value: wanted, updated_at: new Date().toISOString() }),
    },
    deps
  );

  if (!result.ok) {
    throw new SettingsError(`Could not save the setting: ${result.error || result.status}`);
  }

  clearSettingsCache();
  return wanted;
}

/**
 * Does an action of this weight have to ask first?
 *
 * The one place the three levels are turned into a yes or no, so that the
 * server, the agent and the tests cannot drift apart on what 'all' means.
 *
 * @param {'writes'|'destructive'} weight  what the action would do
 * @param {'none'|'destructive'|'all'} level
 */
export function levelRequiresConfirmation(weight, level) {
  const chosen = normalizeConfirmLevel(level);
  if (chosen === 'none') return false;
  if (chosen === 'all') return weight === 'writes' || weight === 'destructive';
  return weight === 'destructive';
}

/* ------------------------------------------------------- background catching */

/**
 * Whether Oscar quietly records the people you mention as you talk.
 *
 * The odd one out among the settings here, because it is the only one that
 * decides whether Oscar collects something rather than how carefully he acts.
 * Say "I'm writing to my sister Olivia" with this on and Olivia lands in your
 * `people` table as your sister, without being mentioned in the answer. With it
 * off, nothing is written unless you actually asked for it — "Olivia is my
 * sister, save that" still works exactly as it always did.
 *
 * OFF BY DEFAULT, and that is a deliberate asymmetry with the confirm level
 * above. That one defaults to the middle setting because its two extremes are
 * opinions. This one has a right answer for an unconfigured deployment:
 * everything in `people` is information about OTHER people, who are not the
 * ones clicking the toggle. Collecting it should be something you switched on,
 * not something you discovered had been happening.
 *
 * Every failure path lands on off, for the same reason: an unreadable row, a
 * timeout and a missing table all mean Oscar does not start keeping notes on
 * your family because the database had a bad afternoon.
 */
const BACKGROUND_CATCHING_KEY = 'background_catching';

/** Off. See above — this is the answer that collects nothing. */
export const DEFAULT_BACKGROUND_CATCHING = false;

let catchingCached = null;

/** Forget the cached toggle. Called after a write, and by the tests. */
export function clearBackgroundCatchingCache() {
  catchingCached = null;
}

/**
 * @returns {boolean} true only for a value that clearly means yes.
 *
 * Anything unrecognised is false, which is the direction that stops collecting
 * rather than the one that starts.
 */
export function normalizeBackgroundCatching(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'on' || text === 'yes';
}

/** The answer when there is no database: the environment, then the default. */
export function backgroundCatchingFromEnv(env = process.env) {
  if (env.OSCAR_BACKGROUND_CATCHING === undefined) return DEFAULT_BACKGROUND_CATCHING;
  return normalizeBackgroundCatching(env.OSCAR_BACKGROUND_CATCHING);
}

/**
 * Is background catching on right now?
 *
 * Never throws and never rejects, like getConfirmLevel — this is read once per
 * answered question, and a settings blip must not be able to fail a request
 * that has already been answered.
 *
 * @returns {Promise<boolean>}
 */
export async function getBackgroundCatching(deps = {}) {
  const env = deps.env || process.env;

  if (catchingCached && Date.now() < catchingCached.until) return catchingCached.on;
  if (!isConfigured(env)) return backgroundCatchingFromEnv(env);

  const result = await dbRequest(
    `settings?key=eq.${encodeURIComponent(BACKGROUND_CATCHING_KEY)}&select=value&limit=1`,
    { method: 'GET' },
    deps
  ).catch(() => ({ ok: false }));

  const row = result.ok && Array.isArray(result.data) ? result.data[0] : null;
  const on = row ? normalizeBackgroundCatching(row.value) : backgroundCatchingFromEnv(env);

  // A failed read is deliberately NOT cached, same as the confirm level: a blip
  // should cost one query rather than ten seconds of the wrong answer.
  if (result.ok) catchingCached = { on, until: Date.now() + CACHE_MS };
  return on;
}

/**
 * Turn it on or off.
 *
 * Stored as a real jsonb boolean rather than the string "true", so anything
 * reading the table directly gets a boolean back and the column stays honest.
 *
 * @param {boolean} on
 * @returns {Promise<boolean>} what is now stored
 */
export async function setBackgroundCatching(on, deps = {}) {
  const env = deps.env || process.env;
  const wanted = normalizeBackgroundCatching(on);

  if (!isConfigured(env)) {
    throw new SettingsError(
      'No database is configured, so there is nowhere to save this — and nowhere to keep the people it would catch. Set OSCAR_BACKGROUND_CATCHING instead.',
      503
    );
  }

  const result = await dbRequest(
    'settings',
    {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        key: BACKGROUND_CATCHING_KEY,
        value: wanted,
        updated_at: new Date().toISOString(),
      }),
    },
    deps
  );

  if (!result.ok) {
    throw new SettingsError(`Could not save the setting: ${result.error || result.status}`);
  }

  clearBackgroundCatchingCache();
  return wanted;
}
