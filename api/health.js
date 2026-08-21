/**
 * api/health.js
 * ----------------------------------------------------------------------------
 * Open this in a browser right after deploying. It tells you whether the
 * environment variables actually landed, without ever echoing their values.
 *
 * Add `?deep=1` to also make a real round trip to Supabase — that's what proves
 * the table exists and the service role key works, rather than just that a
 * variable is set. It's opt-in because the page calls this endpoint on every
 * load and shouldn't pay for a database query each time.
 *
 * Add `?google=1` for the same idea applied to Google: it asks Google which
 * scopes the stored refresh token actually holds and whether each of the five
 * APIs answers a request. A token minted before OSCAR_ALLOW_WRITES was turned
 * on carries read-only scopes for good, and an API left switched off in Cloud
 * Console fails only at call time — neither shows up in the booleans below.
 *
 * Intentionally public: it reports booleans only, so it's still useful when you
 * are locked out and trying to work out why.
 */

import { detectProvider } from '../lib/mailer.js';
import { isConfigured, pingDatabase } from '../lib/db.js';
import { isGoogleConfigured, canWriteGoogle, probeGoogle } from '../lib/google/auth.js';
import { availableTools, isRunnerConfigured } from '../lib/tools/index.js';
import { isPushConfigured, vapidKeys } from '../lib/push.js';
import { MAX_MISSION_STEPS } from '../lib/missions.js';
import { routerModels, isRoutingEnabled } from '../lib/router.js';
import { selfUrl } from '../lib/jobs.js';

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const env = process.env;
  const url = new URL(req.url, 'http://localhost');
  const deep = url.searchParams.get('deep') === '1';

  const database = deep
    ? await pingDatabase()
    : { configured: isConfigured(env) };

  // Same bargain as `deep`, for Google: opt-in because it costs six round trips
  // to Google, and the page hits this endpoint on every load. See probeGoogle
  // for why the env-var booleans below are not enough on their own.
  const googleProbe = url.searchParams.get('google') === '1' ? await probeGoogle({ env }) : undefined;

  res.end(
    JSON.stringify(
      {
        ok: true,
        service: 'oscar',
        time: new Date().toISOString(),
        agent: {
          openaiKey: Boolean(env.OPENAI_API_KEY),
          model: env.OPENAI_MODEL || 'gpt-4o-mini (default)',
          maxWords: Number(env.OSCAR_MAX_WORDS) || 60,
        },
        auth: {
          // Website login
          passkey: Boolean(env.OSCAR_PASSKEY || env.OSCAR_PASSKEY_HASH),
          ownerEmail: Boolean(env.OSCAR_OWNER_EMAIL),
          sessionSecret: Boolean(env.OSCAR_SESSION_SECRET || env.OSCAR_SHARED_SECRET),
          mailProvider: detectProvider(env),
          // Shortcut login
          sharedSecret: Boolean(env.OSCAR_SHARED_SECRET),
        },
        database,
        google: {
          connected: isGoogleConfigured(env),
          writesEnabled: canWriteGoogle(env),
          writeSecretSet: Boolean(env.OSCAR_WRITE_SECRET),
          sendAllowlist: env.GOOGLE_SEND_ALLOWLIST ? 'set' : 'anyone',
          // Only present with ?google=1. `connected` and `writesEnabled` above
          // report what the environment says; this reports what Google says.
          ...(googleProbe ? { probe: googleProbe } : {}),
        },
        confirmation: {
          // Which routes stop and ask before a destructive action.
          shortcut: true,
          webTyped: env.OSCAR_CONFIRM_ALWAYS === '1',
          webDictated: true,
          alsoConfirmsSending: env.OSCAR_CONFIRM_SEND === '1',
        },
        // Surfaced at the top level because a missing OSCAR_ALLOW_WRITES is
        // silent otherwise: read tools work, write tools are simply absent, and
        // the model says "no plans yet" rather than "I can't save plans".
        writes: {
          enabled: env.OSCAR_ALLOW_WRITES === '1',
          proof: env.OSCAR_WRITE_SECRET ? 'session or x-oscar-write' : 'session only',
          ...(env.OSCAR_ALLOW_WRITES === '1'
            ? {}
            : {
                hint:
                  'Set OSCAR_ALLOW_WRITES=1 and redeploy. Without it Oscar can read plans, ' +
                  'calendar and mail but cannot create anything.',
              }),
        },
        routing: {
          enabled: isRoutingEnabled(env),
          ...routerModels(env),
        },
        jobs: {
          // Background work needs the database to checkpoint into.
          available: isConfigured(env),
          // Without a base URL a job cannot hand off to a fresh invocation, so
          // it only advances while the web app is open and polling.
          selfContinue: Boolean(selfUrl(env)),
        },
        plans: {
          // Plans live in Supabase, so they need the database, not Google.
          available: isConfigured(env),
        },
        questions: {
          // Oscar pausing to ask you something needs somewhere to keep the
          // question — a run that suspends with no row to wake it would just
          // be a run that stopped.
          available: isConfigured(env),
        },
        missions: {
          // A mission is a job that keeps its task list in a plan, so it needs
          // both. Writes too — it cannot save a plan it is not allowed to make.
          available: isConfigured(env) && env.OSCAR_ALLOW_WRITES === '1',
          maxSteps: MAX_MISSION_STEPS,
        },
        notifications: {
          // Both halves are needed: keys to sign with, and somewhere to keep
          // the list of devices.
          configured: isPushConfigured(env),
          keys: vapidKeys(env) !== null,
          hint: isPushConfigured(env)
            ? undefined
            : 'Run `npm run vapid`, add both keys to Vercel, and redeploy. See PUSH.md.',
        },
        runner: {
          // Whether a machine COULD pair with this deployment — not whether one
          // is currently running. The queue is deliberately blind to that: a
          // shut laptop is a normal state, and commands simply wait for it.
          configured: isRunnerConfigured(env),
          // Commands are queued in the database like everything else.
          queue: isConfigured(env),
          hint: isRunnerConfigured(env)
            ? undefined
            : 'Set OSCAR_RUNNER_SECRET and redeploy, then run `npm run runner` on your computer.',
        },
        tools: {
          readOnly: availableTools({ canWrite: false }, env).map((t) => t.name),
          withWrite: availableTools({ canWrite: true }, env).map((t) => t.name),
        },
      },
      null,
      2
    )
  );
}
