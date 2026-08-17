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
 * Intentionally public: it reports booleans only, so it's still useful when you
 * are locked out and trying to work out why.
 */

import { detectProvider } from '../lib/mailer.js';
import { isConfigured, pingDatabase } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const env = process.env;
  const url = new URL(req.url, 'http://localhost');
  const deep = url.searchParams.get('deep') === '1';

  const database = deep
    ? await pingDatabase()
    : { configured: isConfigured(env) };

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
      },
      null,
      2
    )
  );
}
