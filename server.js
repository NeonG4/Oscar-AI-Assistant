/**
 * server.js — optional local dev server. `npm start`
 * ----------------------------------------------------------------------------
 * Vercel doesn't use this file; it exists so you can run the whole thing with
 * plain Node (`node server.js`) without installing the Vercel CLI. It serves
 * `public/` and routes `/api/*` to the same handlers Vercel deploys.
 *
 * One difference from production worth knowing: session cookies are marked
 * `Secure`, so browsers only keep them over HTTPS or on `localhost`. Use
 * http://localhost:3000 rather than your LAN IP or login won't stick.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Load .env.local if present, so `node server.js` behaves like `vercel dev`.
try {
  const raw = await fs.readFile(path.join(here, '.env.local'), 'utf8');
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  console.log('loaded .env.local');
} catch {
  console.log('no .env.local found — using the ambient environment');
}

const routes = {
  '/api/ask': (await import('./api/ask.js')).default,
  '/api/auth': (await import('./api/auth.js')).default,
  '/api/session': (await import('./api/session.js')).default,
  '/api/confirm': (await import('./api/confirm.js')).default,
  '/api/jobs': (await import('./api/jobs.js')).default,
  '/api/step': (await import('./api/step.js')).default,
  '/api/history': (await import('./api/history.js')).default,
  '/api/health': (await import('./api/health.js')).default,
  '/api/push': (await import('./api/push.js')).default,
  '/api/runner': (await import('./api/runner.js')).default,
  '/api/questions': (await import('./api/questions.js')).default,
  '/api/settings': (await import('./api/settings.js')).default,
  '/api/mcp': (await import('./api/mcp.js')).default,
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  // Without these two the manifest is served as a download and the icons as
  // nothing, which is enough for a browser to refuse to install the app.
  '.json': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[url.pathname];

  if (handler) {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(err);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'handler threw' }));
    }
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(here, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  try {
    const data = await fs.readFile(file);
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`oscar listening on http://localhost:${PORT}`));
