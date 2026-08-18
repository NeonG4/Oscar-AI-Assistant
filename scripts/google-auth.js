#!/usr/bin/env node
/**
 * scripts/google-auth.js
 * ----------------------------------------------------------------------------
 * One-time Google authorisation. Run it on your own machine:
 *
 *     npm run google-auth
 *
 * It opens a browser, you approve, and it prints a refresh token to paste into
 * Vercel. You should not need to run it again unless the token is revoked or
 * you add new scopes.
 *
 * Why a local script rather than a page on the site: the redirect has to go
 * somewhere you control, and http://localhost is the one redirect URI Google
 * accepts without HTTPS. It also means the refresh token is printed to your own
 * terminal and never travels through the deployed app.
 *
 * Credentials are read from the environment or .env.local, or you can paste
 * them when prompted.
 */

import http from 'node:http';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { exec } from 'node:child_process';
import { SCOPES } from '../lib/google/auth.js';

const PORT = 4321;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

/* --------------------------------------------------------------- .env.local */

function loadEnvFile() {
  try {
    const text = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env.local, that's fine */
  }
}

function openBrowser(url) {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {
    /* if it fails, the URL is printed anyway */
  });
}

/* --------------------------------------------------------------------- main */

loadEnvFile();

const rl = readline.createInterface({ input: stdin, output: stdout });

console.log('\n  Oscar — Google authorisation\n  ' + '─'.repeat(48) + '\n');

const clientId =
  process.env.GOOGLE_CLIENT_ID || (await rl.question('  GOOGLE_CLIENT_ID: ')).trim();
const clientSecret =
  process.env.GOOGLE_CLIENT_SECRET || (await rl.question('  GOOGLE_CLIENT_SECRET: ')).trim();

if (!clientId || !clientSecret) {
  console.error('\n  Both a client id and secret are required. See GOOGLE.md.\n');
  process.exit(1);
}

const writes = process.env.OSCAR_ALLOW_WRITES === '1'
  ? true
  : /^y/i.test(
      (await rl.question('  Allow Oscar to change things (send mail, add events)? [y/N]: ')).trim()
    );

const scopes = writes ? SCOPES.write : SCOPES.read;

console.log('\n  Requesting these scopes:');
for (const scope of scopes) console.log(`    · ${scope.replace('https://www.googleapis.com/auth/', '')}`);

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: scopes.join(' '),
    // Both of these are required to get a refresh token at all. Without
    // access_type=offline Google returns only an access token; without
    // prompt=consent it withholds the refresh token on repeat authorisations,
    // which is a classic hour-long debugging session.
    access_type: 'offline',
    prompt: 'consent',
  });

console.log('\n  Opening your browser. If nothing happens, paste this in:\n');
console.log(`  ${authUrl}\n`);
console.log('  Google will warn that the app is unverified — that is expected for a personal');
console.log('  project. Click Advanced, then "Go to ... (unsafe)".\n');

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/callback') {
      res.statusCode = 404;
      return res.end('Not here.');
    }

    const error = url.searchParams.get('error');
    const received = url.searchParams.get('code');

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><meta charset="utf-8">
       <body style="font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;padding:48px;max-width:32em;margin:auto">
       <h2>${error ? 'Authorisation failed' : 'Done'}</h2>
       <p>${error ? `Google said: <code>${error}</code>` : 'You can close this tab and go back to your terminal.'}</p>
       </body>`
    );

    server.close();
    if (error) reject(new Error(error));
    else if (received) resolve(received);
    else reject(new Error('Google did not return a code.'));
  });

  server.listen(PORT, () => openBrowser(authUrl));
  server.on('error', reject);

  setTimeout(() => {
    server.close();
    reject(new Error('Timed out after five minutes.'));
  }, 300_000);
});

console.log('  Got the code, exchanging it for a refresh token…\n');

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString(),
});

const payload = await res.json();

if (!res.ok || !payload.refresh_token) {
  console.error('  Something went wrong:\n');
  console.error('  ' + JSON.stringify(payload, null, 2).replace(/\n/g, '\n  '));
  if (!payload.refresh_token && res.ok) {
    console.error(
      '\n  Google returned an access token but no refresh token. That happens when you have\n' +
        '  already authorised this app before. Revoke it at\n' +
        '  https://myaccount.google.com/permissions and run this again.\n'
    );
  }
  rl.close();
  process.exit(1);
}

console.log('  ' + '─'.repeat(48));
console.log('\n  Add these to Vercel → Settings → Environment Variables:\n');
console.log(`  GOOGLE_CLIENT_ID       ${clientId}`);
console.log(`  GOOGLE_CLIENT_SECRET   ${clientSecret}`);
console.log(`  GOOGLE_REFRESH_TOKEN   ${payload.refresh_token}`);
if (writes) console.log(`  OSCAR_ALLOW_WRITES     1`);
console.log('\n  ' + '─'.repeat(48));
console.log('\n  Then redeploy:  vercel --prod\n');
console.log('  IMPORTANT: if your OAuth app is still in "Testing" publishing status, this');
console.log('  refresh token expires in 7 days. Set it to "In production" in Google Auth');
console.log('  Platform before you rely on it. See GOOGLE.md.\n');

rl.close();
process.exit(0);
