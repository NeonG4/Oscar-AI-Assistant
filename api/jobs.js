/**
 * api/jobs.js
 * ----------------------------------------------------------------------------
 *   GET  /api/jobs?id=<uuid>   one job: status, live event trace, answer
 *   GET  /api/jobs             recent jobs
 *
 * Creating a job is not done here — /api/ask does it, because the decision to
 * go async is the router's, and the Shortcut should only ever need one URL.
 *
 * AUTH mirrors /api/history: reading back what you asked and what Oscar found
 * requires a full browser login, not the Shortcut key. That key lives in plain
 * text on your phone, so it can start work but not read the archive.
 *
 * The one exception is a signed job token, which lets a caller poll the single
 * job it started without a session — that's what makes a "job started" link
 * usable before you've signed in.
 */

import { getSession } from '../lib/auth.js';
import { applyCors, send } from '../lib/http.js';
import { getJob, listJobs, readJobToken, isJobsConfigured, JobError } from '../lib/jobs.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET.' });

  if (!isJobsConfigured()) {
    return send(res, 200, { ok: true, configured: false, jobs: [], error: 'No database configured.' });
  }

  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');

  const signedIn = Boolean(getSession(req));
  const tokenAllows = id && readJobToken(token, process.env) === String(id);

  if (!signedIn && !tokenAllows) {
    return send(res, 401, { ok: false, error: 'Sign in to view jobs.' });
  }

  try {
    if (id) {
      return send(res, 200, { ok: true, configured: true, job: await getJob(id) });
    }
    // Listing every job is archive access, so it always needs a real session.
    if (!signedIn) return send(res, 401, { ok: false, error: 'Sign in to list jobs.' });

    return send(res, 200, {
      ok: true,
      configured: true,
      jobs: await listJobs({ status: url.searchParams.get('status'), limit: url.searchParams.get('limit') }),
    });
  } catch (err) {
    const status = err instanceof JobError ? err.status : 500;
    return send(res, status, { ok: false, error: (err && err.message) || 'Could not read jobs.' });
  }
}
