/**
 * api/settings.js
 * ----------------------------------------------------------------------------
 * The settings that are not local to a browser.
 *
 *   GET  /api/settings                             -> { confirmLevel, levels, … }
 *   POST /api/settings { confirmLevel: 'all' }      -> save it
 *   POST /api/settings { backgroundCatching: true } -> save that instead
 *
 * A POST sets whichever settings it names and leaves the rest alone, so the
 * page can have one control per setting rather than sending the whole lot back
 * every time one of them changes.
 *
 * See lib/settings.js for what each setting means and why none of them can live
 * in localStorage like the display toggles do.
 *
 * AUTH IS SESSION-ONLY, the same rule as /api/history, /api/push and
 * /api/questions, and for a sharper reason than any of them. This value decides
 * whether Oscar stops to ask before deleting mail or running a command, so
 * writing it is the single most security-relevant thing a request can do
 * without doing anything itself. The Shortcut key sits in plain text on a
 * phone; it can ask questions, and it may not quietly turn the safety off.
 *
 * The runner needs this value too and has no session — it gets it from
 * /api/runner, which speaks its own secret. It is handed the level rather than
 * allowed to set it, which is the right way round.
 */

import { getSession } from '../lib/auth.js';
import { applyCors, readBody, send } from '../lib/http.js';
import { isConfigured } from '../lib/db.js';
import {
  getConfirmLevel,
  setConfirmLevel,
  confirmLevelFromEnv,
  CONFIRM_LEVELS,
  DEFAULT_CONFIRM_LEVEL,
  getNotificationLevel,
  setNotificationLevel,
  NOTIFICATION_LEVELS,
  getBackgroundCatching,
  setBackgroundCatching,
  backgroundCatchingFromEnv,
  DEFAULT_BACKGROUND_CATCHING,
  SettingsError,
} from '../lib/settings.js';

/** Shown next to each choice in the dropdown, so the UI and the API agree. */
const DESCRIPTIONS = {
  none: 'Never ask. Oscar deletes, sends and runs on your word alone.',
  destructive: 'Ask before anything irreversible — deleting, sending, and risky commands.',
  all: 'Ask before anything that changes something. Looking things up never asks.',
};

/** Shown next to each notification level choice in the dropdown. */
const NOTIFICATION_DESCRIPTIONS = {
  'all clear on everything, no confirmation':
    'Notifications are sent but never shown. Destructive commands proceed immediately.',
  'confirmation on only destructive commands':
    'Notifications for destructive actions (delete email, send email, run pwsh command) require a response.',
  'confirmation on all commands':
    'Every notification requires a response before the action proceeds.',
};

/** The one-liner under the toggle. Kept here so the UI and the API agree. */
const CATCHING_DESCRIPTION =
  'Oscar quietly records the people you mention — names, how you know them, contact details — ' +
  'so he knows who you mean next time. Only durable facts, never how somebody is feeling today. ' +
  'With this off, people are saved only when you ask.';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (!getSession(req)) {
    return send(res, 401, { ok: false, error: 'Sign in to change settings.' });
  }

  try {
    if (req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        // False means the dropdown is read-only: there is nowhere to write the
        // answer, so it shows what the environment says and says why.
        storable: isConfigured(),
        confirmLevel: await getConfirmLevel({}),
        levels: CONFIRM_LEVELS.map((level) => ({ level, description: DESCRIPTIONS[level] })),
        default: DEFAULT_CONFIRM_LEVEL,
        fallback: confirmLevelFromEnv(),
        hint: isConfigured()
          ? undefined
          : 'No database is configured, so this is fixed by OSCAR_CONFIRM_LEVEL.',
        notificationLevel: await getNotificationLevel({}),
        notificationLevels: NOTIFICATION_LEVELS.map((level) => ({
          level,
          description: NOTIFICATION_DESCRIPTIONS[level],
        })),

        // Whether Oscar files away the people you mention as you talk. Sent
        // with its own default and env fallback because, unlike the levels
        // above, a deployment with no database has a meaningful answer for it:
        // off, and not changeable from here.
        backgroundCatching: await getBackgroundCatching({}),
        backgroundCatchingDefault: DEFAULT_BACKGROUND_CATCHING,
        backgroundCatchingFallback: backgroundCatchingFromEnv(),
        backgroundCatchingDescription: CATCHING_DESCRIPTION,
      });
    }

    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use GET or POST.' });

    const body = await readBody(req);
    const confirmLevel = body.confirmLevel ?? body.level ?? body.confirm;
    const notificationLevel = body.notificationLevel ?? body.notification_level ?? body.notification;
    const backgroundCatching = body.backgroundCatching ?? body.background_catching;

    let savedConfirm = null;
    let savedNotification = null;
    let savedCatching = null;

    if (confirmLevel != null) {
      savedConfirm = await setConfirmLevel(confirmLevel, {});
      console.log(`[oscar] confirm level set to "${savedConfirm}"`);
    }

    if (notificationLevel != null) {
      savedNotification = await setNotificationLevel(notificationLevel, {});
      console.log(`[oscar] notification level set to "${savedNotification}"`);
    }

    // `!= null` rather than a truthiness check: false is the whole point of
    // this setting, and `if (backgroundCatching)` would make turning it off
    // silently do nothing.
    if (backgroundCatching != null) {
      savedCatching = await setBackgroundCatching(backgroundCatching, {});
      // Worth a log line for the same reason the confirm level is: this decides
      // whether Oscar is keeping notes on the people you mention, and the
      // server log is the only record that it changed.
      console.log(`[oscar] background catching turned ${savedCatching ? 'on' : 'off'}`);
    }

    return send(res, 200, {
      ok: true,
      confirmLevel: savedConfirm,
      notificationLevel: savedNotification,
      backgroundCatching: savedCatching,
    });
  } catch (err) {
    const status = err instanceof SettingsError ? err.status : 500;
    const message = err instanceof SettingsError ? err.message : 'That settings request failed.';
    if (status >= 500) console.error('[oscar] settings:', err);
    return send(res, status, { ok: false, error: message });
  }
}
