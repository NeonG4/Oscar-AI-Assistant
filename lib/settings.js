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
 * THERE ARE TWO SETTINGS HERE
 *
 *   command_policy       whether Oscar may run commands on your computer, and
 *                        how much it asks first. See COMMAND_POLICIES.
 *   background_catching  whether Oscar files away the people you mention as
 *                        you talk, rather than only when asked.
 *
 * THERE USED TO BE FOUR
 *
 * `confirm_level` and `notification_level` were both earlier attempts at the
 * same question command_policy now answers — how much should Oscar ask before
 * it acts. Neither was ever wired to anything: they were written to the
 * database and read back by the settings endpoint alone, so the dropdown
 * remembered your choice and nothing else in the system ever consulted it.
 *
 * They were folded into command_policy on 2026-08-21, which kept the one state
 * they had and it lacked — asking about destructive commands only. A setting
 * that silently does nothing is worse than no setting, because it reads as a
 * promise. If you add a third here, wire it to something first.
 */

import { dbRequest, isConfigured } from './db.js';

/**
 * How long a settings read is reused before going back to the database.
 *
 * The runner asks on every poll and the agent asks on every tool call, so
 * without this a single mission would spend hundreds of round trips confirming
 * a value that changes about twice a year. Ten seconds is short enough that
 * changing a dropdown feels immediate and long enough that the traffic
 * disappears.
 *
 * Serverless makes this weaker than it looks — each instance has its own cache
 * and they expire at different moments — which is fine for a preference and
 * would not be for a permission. Note the direction of the risk: a stale cache
 * can leave Oscar asking when you have just said he needn't, for a few seconds.
 * It cannot leave him silent when you have just asked to be asked, because
 * every value it falls back to is the stricter one.
 */
const CACHE_MS = 10000;

export class SettingsError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
  }
}

/**
 * Forget every cached setting. Called after a write, and by the tests.
 *
 * Deliberately all-or-nothing rather than one cache at a time: a test that
 * resets one setting and inherits another from the test before it fails in a
 * way that is very hard to read.
 */
export function clearSettingsCache() {
  clearBackgroundCatchingCache();
  clearCommandPolicyCache();
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

/* ------------------------------------------------------------ command policy */

/**
 * Whether Oscar may run commands on your computer at all, and how much it asks.
 *
 * The only setting in this file that decides whether something executes on
 * hardware you own, which is why it is the one that has an off switch rather
 * than only degrees of caution.
 *
 *   off          Oscar cannot run anything. run_cmd is withheld from the model,
 *                and the runner is handed no work. Both ends, on purpose.
 *   confirm      Every command asks first, including the harmless ones.
 *   destructive  Only commands that could lose something ask. (default)
 *   open         Commands run without asking. The denylist still applies —
 *                there is no setting that reformats a disk.
 *
 * WHY `destructive` IS THE DEFAULT AND NOT `confirm`
 *
 * A setting that asks about `git status` trains you to approve without reading,
 * and an approval given without reading protects nothing. What `destructive`
 * declines to ask about cannot lose data; what it asks about can. It is also
 * what the runner has always defaulted to, and what both of the settings folded
 * into this one defaulted to, so it is the least surprising answer for a
 * deployment nobody has configured.
 *
 * NOTHING FALLS THROUGH TO `open`. A missing row, an unreadable database and a
 * typo in the environment all land on `destructive`. The failure modes here are
 * allowed to be inconvenient and are not allowed to be silent.
 *
 * This setting absorbed `confirm_level` and `notification_level`, which asked
 * the same question and were wired to nothing. See the file header.
 */
export const COMMAND_POLICIES = ['off', 'confirm', 'destructive', 'open'];

/** Ask about the risky ones. What the runner and both folded settings defaulted to. */
export const DEFAULT_COMMAND_POLICY = 'destructive';

const COMMAND_POLICY_KEY = 'command_policy';

let commandPolicyCached = null;

/** Forget the cached policy. Called after a write, and by the tests. */
export function clearCommandPolicyCache() {
  commandPolicyCached = null;
}

/**
 * @returns {'off'|'confirm'|'destructive'|'open'} the policy, or the default.
 *
 * Note which way an unrecognised value falls: onto `destructive`, never
 * `open`. A typo must not be the thing that turns the asking off.
 */
export function normalizeCommandPolicy(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return COMMAND_POLICIES.includes(text) ? text : DEFAULT_COMMAND_POLICY;
}

/** The policy when there is no database: the environment, then the default. */
export function commandPolicyFromEnv(env = process.env) {
  if (env.OSCAR_COMMAND_POLICY === undefined) return DEFAULT_COMMAND_POLICY;
  return normalizeCommandPolicy(env.OSCAR_COMMAND_POLICY);
}

/**
 * What you chose, from wherever it is written down.
 *
 * Never throws and never rejects. The runner reads this on every poll and the
 * shell tool reads it on every call; a settings blip must not be able to fail a
 * request. An unreadable answer means `destructive`, which still asks about
 * everything that could lose you something.
 *
 * @returns {Promise<'off'|'confirm'|'destructive'|'open'>}
 */
export async function getCommandPolicy(deps = {}) {
  const env = deps.env || process.env;

  if (commandPolicyCached && Date.now() < commandPolicyCached.until) {
    return commandPolicyCached.policy;
  }
  if (!isConfigured(env)) return commandPolicyFromEnv(env);

  const result = await dbRequest(
    `settings?key=eq.${encodeURIComponent(COMMAND_POLICY_KEY)}&select=value&limit=1`,
    { method: 'GET' },
    deps
  ).catch(() => ({ ok: false }));

  const row = result.ok && Array.isArray(result.data) ? result.data[0] : null;
  const policy = row ? normalizeCommandPolicy(row.value) : commandPolicyFromEnv(env);

  // A failed read is deliberately NOT cached, so a blip costs one query rather
  // than ten seconds of a policy you did not choose.
  if (result.ok) commandPolicyCached = { policy, until: Date.now() + CACHE_MS };
  return policy;
}

/**
 * Write the policy down.
 *
 * @param {'off'|'confirm'|'destructive'|'open'} policy
 */
export async function setCommandPolicy(policy, deps = {}) {
  const env = deps.env || process.env;
  const wanted = String(policy == null ? '' : policy).trim().toLowerCase();

  // Strict on the way in, lenient on the way out: a typo here would store the
  // default and then show a dropdown disagreeing with what you clicked.
  if (!COMMAND_POLICIES.includes(wanted)) {
    throw new SettingsError(`"${policy}" is not one of ${COMMAND_POLICIES.join(', ')}.`, 400);
  }
  if (!isConfigured(env)) {
    throw new SettingsError(
      'No database is configured, so there is nowhere to save this. Set OSCAR_COMMAND_POLICY instead.',
      503
    );
  }

  const result = await dbRequest(
    'settings',
    {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        key: COMMAND_POLICY_KEY,
        value: wanted,
        updated_at: new Date().toISOString(),
      }),
    },
    deps
  );

  if (!result.ok) {
    throw new SettingsError(`Could not save the setting: ${result.error || result.status}`);
  }

  clearCommandPolicyCache();
  return wanted;
}
