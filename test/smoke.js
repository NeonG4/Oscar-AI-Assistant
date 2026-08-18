/**
 * test/smoke.js — run with `npm test` (no dependencies, no network, no API key).
 *
 * Exercises the agent, the login flow, and the HTTP handlers against a fake
 * OpenAI and a fake mail provider, so you can confirm the request/response
 * shapes and the security rules before spending a token or sending an email.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { askAgent, clampWords, parseModelPayload, AgentError } from '../lib/agent.js';
import {
  createChallenge,
  createSession,
  generateCode,
  hashCode,
  normalizeCode,
  parseCookies,
  sessionCookie,
  signToken,
  verifyChallenge,
  verifyToken,
  maskEmail,
  checkPassword,
  CODE_LENGTH,
} from '../lib/auth.js';
import { codeEmail, detectProvider, parseAddress, sendCode } from '../lib/mailer.js';
import {
  conversationRow,
  dbConfig,
  isConfigured,
  logConversation,
  pingDatabase,
  recentConversations,
} from '../lib/db.js';
import {
  geocodePlace,
  locateByIp,
  normalizeCoords,
  resolveLocation,
  reverseGeocode,
  locationTool,
  LocationError,
} from '../lib/tools/location.js';
import { describeCode, fetchWeather, unitSet, weatherTool } from '../lib/tools/weather.js';
import { runTool, toolSchemas, isToolsEnabled, availableTools } from '../lib/tools/index.js';
import {
  clearTokenCache,
  getAccessToken,
  googleConfig,
  googleFetch,
  isGoogleConfigured,
  scopesFor,
  GoogleAuthError,
} from '../lib/google/auth.js';
import { listEventsTool, createEventTool, resolveWindow } from '../lib/tools/calendar.js';
import { listTasksTool, createTaskTool, clearListCache } from '../lib/tools/tasks.js';
import {
  buildRawMessage,
  checkRecipients,
  extractBody,
  looksLikeEmail,
  searchEmailTool,
  sendEmailTool,
} from '../lib/tools/gmail.js';
import {
  createConfirmToken,
  readConfirmToken,
  isAffirmative,
  ConfirmError,
} from '../lib/confirm.js';
import { deleteEventTool } from '../lib/tools/calendar.js';
import { deleteTaskTool } from '../lib/tools/tasks.js';
import { trashEmailTool } from '../lib/tools/gmail.js';
import { needsConfirmation, getTool } from '../lib/tools/index.js';
import askHandler from '../api/ask.js';
import confirmHandler from '../api/confirm.js';
import historyHandler from '../api/history.js';
import authHandler from '../api/auth.js';
import sessionHandler from '../api/session.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

function section(title) {
  console.log(`\n— ${title} —`);
}

/* ------------------------------------------------------------------- fakes */

/** Minimal stand-in for the OpenAI endpoint. */
function fakeOpenAI(content, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const payload =
      status === 200
        ? { model: 'fake-model', usage: { total_tokens: 42 }, choices: [{ message: { content } }] }
        : { error: { message: content } };
    return { ok: status === 200, status, text: async () => JSON.stringify(payload) };
  };
  fn.calls = calls;
  return fn;
}

/** Minimal stand-in for a Vercel req/res pair. */
function fakeReq({ method = 'POST', url = '/api/ask', headers = {}, body, cookie } = {}) {
  const stream = new PassThrough();
  if (body !== undefined) stream.end(typeof body === 'string' ? body : JSON.stringify(body));
  else stream.end();
  const merged = { 'user-agent': 'test-agent/1.0', ...headers };
  if (cookie) merged.cookie = cookie;
  return Object.assign(stream, { method, url, headers: merged });
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      this.body = chunk || '';
      this.done = true;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

const GOOD = JSON.stringify({
  title: 'Soft boiled egg',
  answer: 'Six minutes in already-boiling water gives a runny yolk. Chill it right after.',
  detail: 'Seven minutes for a jammy centre, nine for fully set.',
});

const SECRET = 'test-session-secret-value';

/* Baseline env for handler tests. */
function setEnv(overrides = {}) {
  Object.assign(process.env, {
    OPENAI_API_KEY: 'sk-test',
    OSCAR_SHARED_SECRET: 'letmein',
    OSCAR_SESSION_SECRET: SECRET,
    OSCAR_PASSKEY: 'hunter2-correct-horse',
    OSCAR_OWNER_EMAIL: 'owner@example.com',
    ...overrides,
  });
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (overrides.SUPABASE_URL) process.env.SUPABASE_URL = overrides.SUPABASE_URL;
  if (overrides.SUPABASE_SERVICE_ROLE_KEY)
    process.env.SUPABASE_SERVICE_ROLE_KEY = overrides.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.POSTMARK_TOKEN;
  delete process.env.SENDGRID_API_KEY;
  delete process.env.OSCAR_PASSKEY_HASH;
  // Write authority and Google config must never leak between tests — a stale
  // OSCAR_ALLOW_WRITES would make the write-gate tests pass for the wrong reason.
  delete process.env.OSCAR_ALLOW_WRITES;
  delete process.env.OSCAR_WRITE_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  delete process.env.GOOGLE_SEND_ALLOWLIST;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

console.log('\noscar smoke tests');

/* ===================================================================== agent */
section('agent');

await test('clampWords truncates on a word boundary', () => {
  assert.equal(clampWords('one two three four', 2), 'one two…');
  assert.equal(clampWords('one two', 5), 'one two');
});

await test('parseModelPayload strips markdown noise', () => {
  const out = parseModelPayload('{"title":"**Hi**","answer":"a  b","detail":""}');
  assert.equal(out.title, 'Hi');
  assert.equal(out.answer, 'a b');
});

await test('parseModelPayload survives non-JSON output', () => {
  const out = parseModelPayload('just some prose');
  assert.equal(out.answer, 'just some prose');
  assert.equal(out.title, 'Oscar');
});

await test('askAgent sends a well-formed OpenAI request', async () => {
  const fetchImpl = fakeOpenAI(GOOD);
  const out = await askAgent(
    { question: 'how long do i boil an egg', timeZone: 'America/Los_Angeles' },
    { env: { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-4o-mini' }, fetchImpl }
  );

  const sent = fetchImpl.calls[0];
  assert.equal(sent.init.headers.authorization, 'Bearer sk-test');
  assert.equal(sent.body.model, 'gpt-4o-mini');
  assert.equal(sent.body.response_format.type, 'json_object');
  assert.equal(sent.body.messages[1].content, 'how long do i boil an egg');
  assert.match(sent.body.messages[0].content, /at most 60 words/);

  assert.equal(out.title, 'Soft boiled egg');
  assert.match(out.answer, /^Six minutes/);
});

await test('askAgent rejects an empty question', async () => {
  await assert.rejects(
    () => askAgent({ question: '   ' }, { env: { OPENAI_API_KEY: 'sk-test' } }),
    (err) => err instanceof AgentError && err.status === 400
  );
});

await test('askAgent surfaces provider errors', async () => {
  await assert.rejects(
    () =>
      askAgent(
        { question: 'hi' },
        { env: { OPENAI_API_KEY: 'sk-test' }, fetchImpl: fakeOpenAI('rate limited', { status: 429 }) }
      ),
    (err) => err.status === 429
  );
});

/* ================================================================ auth core */
section('auth core');

await test('a signed token round-trips', () => {
  const token = signToken({ t: 'x', exp: Date.now() + 5000 }, SECRET);
  assert.equal(verifyToken(token, SECRET).t, 'x');
});

await test('a tampered payload is rejected', () => {
  const token = signToken({ t: 'session', sub: 'me', exp: Date.now() + 5000 }, SECRET);
  const [data, sig] = token.split('.');
  const evil = Buffer.from(JSON.stringify({ t: 'session', sub: 'attacker', exp: Date.now() + 5000 }))
    .toString('base64url');
  assert.equal(verifyToken(`${evil}.${sig}`, SECRET), null);
  assert.notEqual(verifyToken(`${data}.${sig}`, SECRET), null);
});

await test('a token signed with another secret is rejected', () => {
  const token = signToken({ t: 'session', exp: Date.now() + 5000 }, 'other-secret');
  assert.equal(verifyToken(token, SECRET), null);
});

await test('an expired token is rejected', () => {
  const token = signToken({ t: 'session', exp: Date.now() - 1 }, SECRET);
  assert.equal(verifyToken(token, SECRET), null);
});

await test('generated codes use the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/, `bad code: ${code}`);
  }
});

await test('the challenge stores only a hash, never the code', () => {
  const code = generateCode();
  const challenge = createChallenge({ code, userAgent: 'ua' }, SECRET);
  const payload = verifyToken(challenge, SECRET);
  assert.equal(payload.ch, hashCode(code, SECRET));
  assert.ok(!JSON.stringify(payload).includes(code), 'code leaked into the challenge token');
});

await test('the right code passes, formatted loosely', () => {
  const code = generateCode();
  const challenge = createChallenge({ code, userAgent: 'ua' }, SECRET);
  assert.equal(
    verifyChallenge({ challenge, code: ` ${code.toLowerCase()} `, userAgent: 'ua' }, SECRET),
    true
  );
});

await test('the wrong code fails', () => {
  const challenge = createChallenge({ code: 'ABCDEF', userAgent: 'ua' }, SECRET);
  assert.throws(
    () => verifyChallenge({ challenge, code: 'ABCDEG', userAgent: 'ua' }, SECRET),
    /not right/
  );
});

await test('a challenge cannot be replayed from another browser', () => {
  const code = generateCode();
  const challenge = createChallenge({ code, userAgent: 'safari' }, SECRET);
  assert.throws(
    () => verifyChallenge({ challenge, code, userAgent: 'attacker-curl' }, SECRET),
    /different browser/
  );
});

await test('an expired challenge fails', () => {
  const stale = signToken({ t: 'challenge', ch: 'x', ua: 'y', exp: Date.now() - 1 }, SECRET);
  assert.throws(
    () => verifyChallenge({ challenge: stale, code: 'ABCDEF', userAgent: 'ua' }, SECRET),
    /expired/
  );
});

await test('normalizeCode strips separators and case', () => {
  assert.equal(normalizeCode(' a1-b2 c3 '), 'A1B2C3');
});

await test('checkPassword works with plaintext and with a hash', () => {
  assert.equal(checkPassword('pw', { OSCAR_PASSKEY: 'pw' }), true);
  assert.equal(checkPassword('nope', { OSCAR_PASSKEY: 'pw' }), false);
  // sha256("pw") — uppercased to prove the comparison normalises case
  const hash = '30c952fab122c3f9759f02a6d95c3758b246b4fee239957b2d4fee46e26170c4';
  assert.equal(checkPassword('pw', { OSCAR_PASSKEY_HASH: hash.toUpperCase() }), true);
  assert.equal(checkPassword('nope', { OSCAR_PASSKEY_HASH: hash }), false);
});

await test('the session cookie is HttpOnly, Secure and SameSite', () => {
  const cookie = sessionCookie(createSession('me@example.com', SECRET));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=\d+/);
});

await test('parseCookies handles multiple cookies', () => {
  const jar = parseCookies('a=1; oscar_session=tok.en; b=2');
  assert.equal(jar.oscar_session, 'tok.en');
});

await test('maskEmail hides most of the address', () => {
  assert.equal(maskEmail('davidsomeone@gmail.com'), 'da**********@gmail.com');
});

/* =================================================================== mailer */
section('mailer');

await test('provider is auto-detected from whichever key is set', () => {
  assert.equal(detectProvider({}), 'log');
  assert.equal(detectProvider({ RESEND_API_KEY: 'x' }), 'resend');
  assert.equal(detectProvider({ POSTMARK_TOKEN: 'x' }), 'postmark');
  assert.equal(detectProvider({ SENDGRID_API_KEY: 'x' }), 'sendgrid');
});

await test('parseAddress splits a display name', () => {
  assert.deepEqual(parseAddress('Oscar <a@b.com>'), { name: 'Oscar', email: 'a@b.com' });
  assert.deepEqual(parseAddress('a@b.com'), { name: 'Oscar', email: 'a@b.com' });
});

await test('the email contains the code and an expiry', () => {
  const mail = codeEmail('A1B2C3', 10);
  assert.match(mail.subject, /A1B2C3/);
  assert.match(mail.text, /A1B2C3/);
  assert.match(mail.html, /A1B2C3/);
  assert.match(mail.text, /10 minutes/);
});

await test('sendCode posts to Resend when its key is present', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, text: async () => '{}' };
  };
  const out = await sendCode(
    { to: 'me@example.com', code: 'A1B2C3' },
    { env: { RESEND_API_KEY: 're_test' }, fetchImpl }
  );
  assert.equal(out.provider, 'resend');
  assert.equal(out.delivered, true);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.authorization, 'Bearer re_test');
  assert.deepEqual(calls[0].body.to, ['me@example.com']);
});

await test('sendCode reports delivered:false when no provider is configured', async () => {
  const out = await sendCode({ to: 'me@example.com', code: 'A1B2C3' }, { env: {} });
  assert.equal(out.provider, 'log');
  assert.equal(out.delivered, false);
});

/* ============================================================ login handler */
section('login endpoint');

await test('the wrong password is refused', async () => {
  setEnv();
  const res = fakeRes();
  await authHandler(fakeReq({ url: '/api/auth', body: { action: 'start', password: 'wrong' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().ok, false);
  assert.equal(res.headers['set-cookie'], undefined);
});

await test('the right password issues a challenge but no session yet', async () => {
  setEnv();
  const res = fakeRes();
  await authHandler(
    fakeReq({ url: '/api/auth', body: { action: 'start', password: 'hunter2-correct-horse' } }),
    res
  );
  const data = res.json();
  assert.equal(res.statusCode, 200);
  assert.ok(data.challenge, 'expected a challenge token');
  assert.equal(data.sentTo, 'ow***@example.com');
  assert.equal(res.headers['set-cookie'], undefined, 'password alone must not log you in');
});

/**
 * Full two-step login, capturing the code the way the log-provider emits it.
 * Returns the Set-Cookie value so later tests can act as a signed-in browser.
 */
async function login() {
  setEnv();

  let captured = null;
  const realLog = console.log;
  console.log = (...args) => {
    const match = /code for [^:]+: ([A-Z0-9]+)/.exec(args.join(' '));
    if (match) captured = match[1];
  };

  const startRes = fakeRes();
  await authHandler(
    fakeReq({ url: '/api/auth', body: { action: 'start', password: 'hunter2-correct-horse' } }),
    startRes
  );
  console.log = realLog;

  const { challenge } = startRes.json();
  const verifyRes = fakeRes();
  await authHandler(
    fakeReq({ url: '/api/auth', body: { action: 'verify', challenge, code: captured } }),
    verifyRes
  );

  return { code: captured, challenge, verifyRes };
}

await test('password then emailed code sets a session cookie', async () => {
  const { code, verifyRes } = await login();
  assert.ok(code, 'no code was emitted');
  assert.equal(verifyRes.statusCode, 200);
  assert.equal(verifyRes.json().ok, true);
  assert.match(verifyRes.headers['set-cookie'], /^oscar_session=/);
});

await test('a wrong code does not set a session cookie', async () => {
  setEnv();
  const startRes = fakeRes();
  await authHandler(
    fakeReq({ url: '/api/auth', body: { action: 'start', password: 'hunter2-correct-horse' } }),
    startRes
  );
  const res = fakeRes();
  await authHandler(
    fakeReq({
      url: '/api/auth',
      body: { action: 'verify', challenge: startRes.json().challenge, code: 'ZZZZZZ' },
    }),
    res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['set-cookie'], undefined);
});

await test('a forged challenge is refused', async () => {
  setEnv();
  const forged = signToken(
    { t: 'challenge', ch: hashCode('ABCDEF', 'guessed-secret'), ua: 'x', exp: Date.now() + 60000 },
    'guessed-secret'
  );
  const res = fakeRes();
  await authHandler(
    fakeReq({ url: '/api/auth', body: { action: 'verify', challenge: forged, code: 'ABCDEF' } }),
    res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['set-cookie'], undefined);
});

await test('logout clears the cookie', async () => {
  setEnv();
  const res = fakeRes();
  await authHandler(fakeReq({ url: '/api/auth', body: { action: 'logout' } }), res);
  assert.match(res.headers['set-cookie'], /Max-Age=0/);
});

await test('/api/session reports the signed-in state', async () => {
  setEnv();
  const anon = fakeRes();
  sessionHandler(fakeReq({ method: 'GET', url: '/api/session' }), anon);
  assert.equal(anon.json().authed, false);

  const cookie = `oscar_session=${createSession('owner@example.com', SECRET)}`;
  const authed = fakeRes();
  sessionHandler(fakeReq({ method: 'GET', url: '/api/session', cookie }), authed);
  assert.equal(authed.json().authed, true);
  assert.equal(authed.json().email, 'ow***@example.com');
});

/* ============================================================== ask handler */
section('ask endpoint');

await test('an unauthenticated ask is refused', async () => {
  setEnv();
  globalThis.fetch = fakeOpenAI(GOOD);
  const res = fakeRes();
  await askHandler(fakeReq({ body: { question: 'hi' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().ok, false);
});

await test('the Shortcut key still works', async () => {
  setEnv();
  globalThis.fetch = fakeOpenAI(GOOD);
  const res = fakeRes();
  await askHandler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'boil an egg?' } }),
    res
  );
  const data = res.json();
  assert.equal(res.statusCode, 200);
  assert.equal(data.via, 'key');
  assert.ok(data.speak.includes('Six minutes'));
});

await test('a wrong Shortcut key is refused', async () => {
  setEnv();
  const res = fakeRes();
  await askHandler(fakeReq({ headers: { 'x-oscar-key': 'nope' }, body: { question: 'hi' } }), res);
  assert.equal(res.statusCode, 401);
});

await test('a login session works without the key', async () => {
  setEnv();
  globalThis.fetch = fakeOpenAI(GOOD);
  const cookie = `oscar_session=${createSession('owner@example.com', SECRET)}`;
  const res = fakeRes();
  await askHandler(fakeReq({ cookie, body: { question: 'boil an egg?' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().via, 'session');
});

await test('a session cookie signed with the wrong secret is refused', async () => {
  setEnv();
  const cookie = `oscar_session=${createSession('attacker@evil.com', 'wrong-secret')}`;
  const res = fakeRes();
  await askHandler(fakeReq({ cookie, body: { question: 'hi' } }), res);
  assert.equal(res.statusCode, 401);
});

await test('an expired session is refused', async () => {
  setEnv();
  const expired = signToken({ t: 'session', sub: 'me', exp: Date.now() - 1000 }, SECRET);
  const res = fakeRes();
  await askHandler(fakeReq({ cookie: `oscar_session=${expired}`, body: { question: 'hi' } }), res);
  assert.equal(res.statusCode, 401);
});

await test('CORS never reflects a foreign origin with credentials', async () => {
  setEnv();
  const res = fakeRes();
  await askHandler(
    fakeReq({
      method: 'GET',
      url: '/api/ask?q=hi',
      headers: { origin: 'https://evil.example', host: 'oscar.vercel.app' },
    }),
    res
  );
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
});

await test('CORS does allow this deployment own origin', async () => {
  setEnv();
  globalThis.fetch = fakeOpenAI(GOOD);
  const res = fakeRes();
  await askHandler(
    fakeReq({
      method: 'GET',
      url: '/api/ask?q=hi&key=letmein',
      headers: { origin: 'https://oscar.vercel.app', host: 'oscar.vercel.app' },
    }),
    res
  );
  assert.equal(res.headers['access-control-allow-origin'], 'https://oscar.vercel.app');
});

await test('handler accepts a plain-text body', async () => {
  setEnv();
  globalThis.fetch = fakeOpenAI(GOOD);
  const res = fakeRes();
  await askHandler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: 'what time is it in tokyo' }),
    res
  );
  assert.equal(res.json().question, 'what time is it in tokyo');
});

await test('handler forwards the tz field into the prompt', async () => {
  setEnv();
  const spy = fakeOpenAI(GOOD);
  globalThis.fetch = spy;
  const res = fakeRes();
  await askHandler(
    fakeReq({
      headers: { 'x-oscar-key': 'letmein' },
      body: { question: 'what time is it', tz: 'America/Los_Angeles' },
    }),
    res
  );
  assert.match(spy.calls[0].body.messages[0].content, /America\/Los_Angeles/);
});

await test('errors still come back as readable notification text', async () => {
  setEnv();
  globalThis.fetch = fakeOpenAI('insufficient_quota', { status: 429 });
  const res = fakeRes();
  await askHandler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'hi' } }),
    res
  );
  assert.equal(res.statusCode, 429);
  assert.match(res.json().answer, /insufficient_quota/);
});


/* ================================================================ database */
section('database');

/** Minimal stand-in for Supabase's REST API. */
function fakeSupabase({ status = 201, rows = [] } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: status < 400,
      status,
      text: async () => (init.method === 'GET' ? JSON.stringify(rows) : ''),
    };
  };
  fn.calls = calls;
  return fn;
}

const DB_ENV = {
  SUPABASE_URL: 'https://abc123.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

await test('dbConfig requires both variables', () => {
  assert.equal(dbConfig({}), null);
  assert.equal(dbConfig({ SUPABASE_URL: 'https://x.supabase.co' }), null);
  assert.equal(dbConfig(DB_ENV).table, 'conversations');
  // a trailing slash on the URL must not produce a double slash
  assert.equal(dbConfig({ ...DB_ENV, SUPABASE_URL: 'https://x.supabase.co/' }).url, 'https://x.supabase.co');
});

await test('logging no-ops cleanly when Supabase is not configured', async () => {
  const out = await logConversation({ question: 'hi' }, { env: {} });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
});

await test('logConversation posts to the right table with auth headers', async () => {
  const fetchImpl = fakeSupabase();
  const out = await logConversation(
    conversationRow({
      question: 'boil an egg?',
      timeZone: 'America/Los_Angeles',
      result: {
        title: 'Egg',
        answer: 'Six minutes.',
        detail: '',
        model: 'gpt-4o-mini',
        elapsedMs: 900,
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      status: 200,
      via: 'key',
      source: 'shortcut',
      totalMs: 1100,
    }),
    { env: DB_ENV, fetchImpl }
  );

  assert.equal(out.ok, true);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://abc123.supabase.co/rest/v1/conversations');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.apikey, 'service-role-key');
  assert.equal(call.init.headers.authorization, 'Bearer service-role-key');
  assert.equal(call.body.question, 'boil an egg?');
  assert.equal(call.body.ok, true);
  assert.equal(call.body.total_tokens, 120);
  assert.equal(call.body.via, 'key');
  assert.equal(call.body.total_ms, 1100);
});

await test('conversationRow records failures with the error text', () => {
  const row = conversationRow({
    question: 'hi',
    error: 'The model provider returned an error.',
    status: 429,
    via: 'session',
    totalMs: 50,
  });
  assert.equal(row.ok, false);
  assert.equal(row.status, 429);
  assert.match(row.error, /model provider/);
  assert.equal(row.answer, null);
});

await test('a database outage is reported, not thrown', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const out = await logConversation({ question: 'hi' }, { env: DB_ENV, fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.error, /ECONNREFUSED/);
});

await test('a database error response is reported, not thrown', async () => {
  const out = await logConversation(
    { question: 'hi' },
    { env: DB_ENV, fetchImpl: fakeSupabase({ status: 401 }) }
  );
  assert.equal(out.ok, false);
});

await test('recentConversations builds a newest-first query', async () => {
  const fetchImpl = fakeSupabase({ status: 200, rows: [{ id: 1, question: 'hi' }] });
  const out = await recentConversations({ limit: 10 }, { env: DB_ENV, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.rows.length, 1);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get('order'), 'created_at.desc');
  assert.equal(url.searchParams.get('limit'), '10');
});

await test('search terms are sanitised into a safe ilike filter', async () => {
  const fetchImpl = fakeSupabase({ status: 200 });
  await recentConversations({ search: 'egg,boil.(x)' }, { env: DB_ENV, fetchImpl });
  const url = new URL(fetchImpl.calls[0].url);
  const filter = url.searchParams.get('question');
  assert.match(filter, /^ilike\.\*/);
  for (const ch of [',', '.', '(', ')', '%']) {
    assert.ok(!filter.slice(7).includes(ch), `unsanitised "${ch}" reached the filter`);
  }
});

await test('the limit is clamped to a sane range', async () => {
  const fetchImpl = fakeSupabase({ status: 200 });
  await recentConversations({ limit: 9999 }, { env: DB_ENV, fetchImpl });
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('limit'), '100');
});

await test('pingDatabase distinguishes unconfigured from unreachable', async () => {
  assert.deepEqual(await pingDatabase({ env: {} }), { configured: false, reachable: false });
  const good = await pingDatabase({ env: DB_ENV, fetchImpl: fakeSupabase({ status: 200 }) });
  assert.equal(good.reachable, true);
  const bad = await pingDatabase({ env: DB_ENV, fetchImpl: fakeSupabase({ status: 404 }) });
  assert.equal(bad.reachable, false);
});

/* ========================================================= logging via ask */
section('ask logging');

/** Routes OpenAI calls to one fake and Supabase calls to another. */
function splitFetch(openai, supabase) {
  const fn = async (url, init) =>
    String(url).includes('supabase') ? supabase(url, init) : openai(url, init);
  fn.supabase = supabase;
  return fn;
}

await test('a successful ask writes a row', async () => {
  setEnv(DB_ENV);
  const supabase = fakeSupabase();
  globalThis.fetch = splitFetch(fakeOpenAI(GOOD), supabase);

  const res = fakeRes();
  await askHandler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'boil an egg?' } }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(supabase.calls.length, 1, 'expected exactly one insert');
  const row = supabase.calls[0].body;
  assert.equal(row.question, 'boil an egg?');
  assert.equal(row.ok, true);
  assert.equal(row.source, 'shortcut');
  assert.ok(row.total_ms >= 0);
});

await test('a failed ask also writes a row', async () => {
  setEnv(DB_ENV);
  const supabase = fakeSupabase();
  globalThis.fetch = splitFetch(fakeOpenAI('insufficient_quota', { status: 429 }), supabase);

  const res = fakeRes();
  await askHandler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'hi' } }),
    res
  );

  assert.equal(res.statusCode, 429);
  assert.equal(supabase.calls.length, 1);
  assert.equal(supabase.calls[0].body.ok, false);
  assert.equal(supabase.calls[0].body.status, 429);
  assert.match(supabase.calls[0].body.error, /insufficient_quota/);
});

await test('unauthorised requests are NOT logged', async () => {
  setEnv(DB_ENV);
  const supabase = fakeSupabase();
  globalThis.fetch = splitFetch(fakeOpenAI(GOOD), supabase);

  const res = fakeRes();
  await askHandler(fakeReq({ body: { question: 'let me fill your database' } }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(supabase.calls.length, 0, 'an unauthenticated request reached the database');
});

await test('a database outage still returns the answer', async () => {
  setEnv(DB_ENV);
  const brokenSupabase = async () => {
    throw new Error('supabase is down');
  };
  globalThis.fetch = splitFetch(fakeOpenAI(GOOD), brokenSupabase);

  const res = fakeRes();
  await askHandler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'boil an egg?' } }),
    res
  );

  assert.equal(res.statusCode, 200, 'a logging failure must never break an answer');
  assert.match(res.json().answer, /Six minutes/);
});

await test('the browser console is tagged as such', async () => {
  setEnv(DB_ENV);
  const supabase = fakeSupabase();
  globalThis.fetch = splitFetch(fakeOpenAI(GOOD), supabase);
  const cookie = `oscar_session=${createSession('owner@example.com', SECRET)}`;

  const res = fakeRes();
  await askHandler(fakeReq({ cookie, body: { question: 'hi' } }), res);

  assert.equal(supabase.calls[0].body.source, 'console');
  assert.equal(supabase.calls[0].body.via, 'session');
});

/* ========================================================= history endpoint */
section('history endpoint');

await test('history refuses an unauthenticated request', async () => {
  setEnv(DB_ENV);
  const res = fakeRes();
  await historyHandler(fakeReq({ method: 'GET', url: '/api/history' }), res);
  assert.equal(res.statusCode, 401);
});

await test('history refuses the Shortcut key — session only', async () => {
  setEnv(DB_ENV);
  const res = fakeRes();
  await historyHandler(
    fakeReq({ method: 'GET', url: '/api/history', headers: { 'x-oscar-key': 'letmein' } }),
    res
  );
  assert.equal(res.statusCode, 401, 'the phone key must not be able to read history');
});

await test('history returns rows for a signed-in session', async () => {
  setEnv(DB_ENV);
  globalThis.fetch = fakeSupabase({
    status: 200,
    rows: [{ id: 2, question: 'hi', answer: 'hello', ok: true, created_at: new Date().toISOString() }],
  });
  const cookie = `oscar_session=${createSession('owner@example.com', SECRET)}`;
  const res = fakeRes();
  await historyHandler(fakeReq({ method: 'GET', url: '/api/history?limit=5', cookie }), res);

  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.equal(data.ok, true);
  assert.equal(data.rows.length, 1);
});

await test('history explains itself when no database is configured', async () => {
  setEnv();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cookie = `oscar_session=${createSession('owner@example.com', SECRET)}`;
  const res = fakeRes();
  await historyHandler(fakeReq({ method: 'GET', url: '/api/history', cookie }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().configured, false);
});


/* =================================================================== tools */
section('location tool');

/** Routes each upstream host to a canned response. */
function fakeWorld(overrides = {}) {
  const calls = [];
  const fn = async (url) => {
    const href = String(url);
    calls.push(href);
    const pick = (host, body, status = 200) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
    });

    if (href.includes('geocoding-api.open-meteo.com')) {
      if (overrides.geocodeEmpty) return pick('geo', { results: [] });
      if (overrides.geocodeFails) return pick('geo', {}, 500);
      return pick('geo', {
        results: [
          { name: 'Portland', latitude: 43.66, longitude: -70.25, admin1: 'Maine', country: 'United States', population: 66000, timezone: 'America/New_York' },
          { name: 'Portland', latitude: 45.52, longitude: -122.68, admin1: 'Oregon', country: 'United States', population: 652000, timezone: 'America/Los_Angeles' },
        ],
      });
    }
    if (href.includes('nominatim')) {
      if (overrides.reverseFails) return pick('rev', {}, 429);
      return pick('rev', { address: { city: 'Bellevue', state: 'Washington', country: 'United States' } });
    }
    if (href.includes('ipapi.co')) {
      if (overrides.ipFails) return pick('ip', { error: true, reason: 'RateLimited' });
      return pick('ip', { latitude: 47.6, longitude: -122.33, city: 'Seattle', region: 'Washington', country_name: 'United States', timezone: 'America/Los_Angeles' });
    }
    if (href.includes('api.open-meteo.com')) {
      if (overrides.weatherFails) return pick('wx', {}, 503);
      return pick('wx', {
        timezone: 'America/Los_Angeles',
        current: { time: '2026-08-17T12:00', temperature_2m: 71.4, apparent_temperature: 69.8, relative_humidity_2m: 55, precipitation: 0, weather_code: 3, wind_speed_10m: 8.2, wind_gusts_10m: 14.9, is_day: 1 },
        daily: {
          time: ['2026-08-17', '2026-08-18'],
          weather_code: [3, 61],
          temperature_2m_max: [76.1, 68.4],
          temperature_2m_min: [58.2, 55.0],
          precipitation_sum: [0, 0.31],
          precipitation_probability_max: [5, 80],
          wind_speed_10m_max: [11.0, 15.5],
          sunrise: ['2026-08-17T06:12', '2026-08-18T06:13'],
          sunset: ['2026-08-17T20:14', '2026-08-18T20:12'],
        },
      });
    }
    throw new Error(`unexpected host: ${href}`);
  };
  fn.calls = calls;
  return fn;
}

await test('normalizeCoords rejects impossible and null-island values', () => {
  assert.equal(normalizeCoords(91, 0), null);
  assert.equal(normalizeCoords(0, 181), null);
  assert.equal(normalizeCoords('abc', 5), null);
  assert.equal(normalizeCoords(0, 0), null, '0,0 is almost always a missing value');
  assert.deepEqual(normalizeCoords(47.60621, -122.33207), { latitude: 47.6062, longitude: -122.3321 });
});

await test('geocoding picks the best-known place for an ambiguous name', async () => {
  const hit = await geocodePlace('Portland', { fetchImpl: fakeWorld() });
  assert.equal(hit.region, 'Oregon', 'should prefer the larger Portland');
  assert.equal(hit.latitude, 45.52);
});

await test('geocoding an unknown place returns null', async () => {
  assert.equal(await geocodePlace('zzzznowhere', { fetchImpl: fakeWorld({ geocodeEmpty: true }) }), null);
  assert.equal(await geocodePlace('', { fetchImpl: fakeWorld() }), null);
});

await test('reverse geocoding degrades to null instead of throwing', async () => {
  const ok = await reverseGeocode(47.6, -122.33, { fetchImpl: fakeWorld(), env: {} });
  assert.equal(ok.name, 'Bellevue');
  const failed = await reverseGeocode(47.6, -122.33, { fetchImpl: fakeWorld({ reverseFails: true }), env: {} });
  assert.equal(failed, null, 'a reverse-geocode failure must never break the request');
});

await test('private and loopback IPs are not sent to the lookup service', async () => {
  const fetchImpl = fakeWorld();
  for (const ip of ['127.0.0.1', '192.168.1.5', '10.0.0.3', '172.16.4.2', '::1', 'unknown', '']) {
    assert.equal(await locateByIp(ip, { fetchImpl }), null, `${ip} should be skipped`);
  }
  assert.equal(fetchImpl.calls.length, 0, 'no network call should have been made');
});

await test('resolveLocation prefers an explicit place over GPS', async () => {
  const out = await resolveLocation(
    { place: 'Portland', coords: { latitude: 47.6, longitude: -122.33 }, ip: '8.8.8.8' },
    { fetchImpl: fakeWorld(), env: {} }
  );
  assert.equal(out.source, 'place');
  assert.equal(out.region, 'Oregon');
});

await test('resolveLocation prefers GPS over IP', async () => {
  const out = await resolveLocation(
    { coords: { latitude: 47.61, longitude: -122.33 }, ip: '8.8.8.8' },
    { fetchImpl: fakeWorld(), env: {} }
  );
  assert.equal(out.source, 'gps');
  assert.equal(out.accurate, true);
  assert.equal(out.name, 'Bellevue', 'GPS coordinates should get a name via reverse geocoding');
});

await test('resolveLocation falls back to IP, and flags it as inaccurate', async () => {
  const out = await resolveLocation({ ip: '8.8.8.8' }, { fetchImpl: fakeWorld(), env: {} });
  assert.equal(out.source, 'ip');
  assert.equal(out.accurate, false, 'an IP guess must be marked inaccurate');
  assert.equal(out.name, 'Seattle');
});

await test('resolveLocation falls back to the configured home location', async () => {
  const out = await resolveLocation(
    { ip: '127.0.0.1' },
    { fetchImpl: fakeWorld(), env: { OSCAR_HOME_LOCATION: 'Portland' } }
  );
  assert.equal(out.source, 'home');
  assert.equal(out.accurate, false);
});

await test('resolveLocation gives a useful error when everything fails', async () => {
  await assert.rejects(
    () => resolveLocation({ ip: '127.0.0.1' }, { fetchImpl: fakeWorld(), env: {} }),
    (err) => err instanceof LocationError && /Get Current Location|OSCAR_HOME_LOCATION/.test(err.message)
  );
});

await test('the location tool reports an approximate result honestly', async () => {
  const out = await locationTool.run({}, { ip: '8.8.8.8', fetchImpl: fakeWorld(), env: {} });
  assert.equal(out.accurate, false);
  assert.match(out.note, /IP address/);
  assert.equal(out.place, 'Seattle, Washington, United States');
});

section('weather tool');

await test('WMO codes become words a model can use', () => {
  assert.equal(describeCode(0), 'clear');
  assert.equal(describeCode(61), 'light rain');
  assert.equal(describeCode(95), 'thunderstorms');
  assert.equal(describeCode(12345), 'unsettled', 'unknown codes must not produce undefined');
});

await test('units default to imperial and switch on OSCAR_UNITS', () => {
  assert.equal(unitSet({}).temperature_unit, 'fahrenheit');
  assert.equal(unitSet({ OSCAR_UNITS: 'metric' }).temperature_unit, 'celsius');
  assert.equal(unitSet({ OSCAR_UNITS: 'METRIC' }).labels.wind, 'km/h');
});

await test('fetchWeather requests the right units and shapes the response', async () => {
  const fetchImpl = fakeWorld();
  const out = await fetchWeather({ latitude: 47.6, longitude: -122.33, days: 2 }, { fetchImpl, env: {} });

  const url = new URL(fetchImpl.calls[0]);
  assert.equal(url.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'mph');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.equal(url.searchParams.get('forecast_days'), '2');

  assert.equal(out.current.temperature, 71);
  assert.equal(out.current.conditions, 'overcast');
  assert.equal(out.daily.length, 2);
  assert.equal(out.daily[1].conditions, 'light rain');
  assert.equal(out.daily[1].chanceOfRain, 80);
});

await test('fetchWeather clamps the forecast length', async () => {
  const fetchImpl = fakeWorld();
  await fetchWeather({ latitude: 47.6, longitude: -122.33, days: 99 }, { fetchImpl, env: {} });
  assert.equal(new URL(fetchImpl.calls[0]).searchParams.get('forecast_days'), '7');
});

await test('the weather tool resolves a place name without a second model round trip', async () => {
  const fetchImpl = fakeWorld();
  const out = await weatherTool.run({ place: 'Portland' }, { fetchImpl, env: {} });
  assert.match(out.place, /Portland, Oregon/);
  assert.equal(out.current.conditions, 'overcast');
  assert.equal(out.units.temp, '°F');
  assert.equal(out.forecast.length, 1, 'a single-day request should not ship a week of data');
});

await test('the weather tool uses GPS when given no arguments', async () => {
  const out = await weatherTool.run(
    {},
    { coords: { latitude: 47.61, longitude: -122.33 }, fetchImpl: fakeWorld(), env: {} }
  );
  assert.equal(out.place, 'Bellevue, Washington, United States');
});

await test('the weather tool marks an IP-derived location as approximate', async () => {
  const out = await weatherTool.run({}, { ip: '8.8.8.8', fetchImpl: fakeWorld(), env: {} });
  assert.match(out.place, /approximate/);
});

section('tool registry');

await test('schemas are shaped the way OpenAI expects', () => {
  const schemas = toolSchemas();
  assert.equal(schemas.length, 2);
  for (const s of schemas) {
    assert.equal(s.type, 'function');
    assert.ok(s.function.name && s.function.description);
    assert.equal(s.function.parameters.type, 'object');
  }
  assert.deepEqual(schemas.map((s) => s.function.name).sort(), ['get_location', 'get_weather']);
});

await test('runTool parses JSON arguments from the model', async () => {
  const out = await runTool('get_weather', '{"place":"Portland"}', { fetchImpl: fakeWorld(), env: {} });
  assert.ok(out.result);
  assert.match(out.result.place, /Portland/);
});

await test('runTool never throws — a broken tool returns an error field', async () => {
  const unknown = await runTool('get_pizza', '{}', {});
  assert.match(unknown.error, /no tool called/);

  const badArgs = await runTool('get_weather', '{not json', {});
  assert.match(badArgs.error, /valid JSON/);

  const upstreamDown = await runTool('get_weather', '{"place":"Portland"}', {
    fetchImpl: fakeWorld({ weatherFails: true }),
    env: {},
  });
  assert.ok(upstreamDown.error, 'an upstream failure must surface as an error, not an exception');
});

await test('tools can be switched off entirely', () => {
  assert.equal(isToolsEnabled({}), true);
  assert.equal(isToolsEnabled({ OSCAR_DISABLE_TOOLS: '1' }), false);
});

section('tool-calling loop');

/** OpenAI fake that emits a tool call on the first turn, then a final answer. */
function fakeOpenAIWithTools(steps) {
  let turn = 0;
  const bodies = [];
  return async (url, init) => {
    if (!String(url).includes('openai')) return fakeWorld()(url, init);
    bodies.push(JSON.parse(init.body));
    const step = steps[Math.min(turn++, steps.length - 1)];
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: 'fake-model',
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          choices: [{ message: step, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }],
        }),
    };
  };
}

const WEATHER_CALL = {
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"place":"Portland"}' } },
  ],
};
const FINAL = {
  role: 'assistant',
  content: JSON.stringify({ title: 'Portland weather', answer: 'Overcast and 71 degrees in Portland.', detail: '' }),
};

await test('the agent calls a tool then answers with the result', async () => {
  const fetchImpl = fakeOpenAIWithTools([WEATHER_CALL, FINAL]);
  const out = await askAgent(
    { question: "what's the weather in Portland" },
    { env: { OPENAI_API_KEY: 'sk-test' }, fetchImpl }
  );
  assert.deepEqual(out.toolsUsed, ['get_weather']);
  assert.match(out.answer, /Overcast/);
  assert.equal(out.usage.total_tokens, 240, 'usage should accumulate across both model calls');
});

await test('the tool result is fed back as a tool message', async () => {
  const bodies = [];
  const inner = fakeOpenAIWithTools([WEATHER_CALL, FINAL]);
  const fetchImpl = async (url, init) => {
    if (String(url).includes('openai')) bodies.push(JSON.parse(init.body));
    return inner(url, init);
  };
  await askAgent({ question: 'weather?' }, { env: { OPENAI_API_KEY: 'sk-test' }, fetchImpl });

  const second = bodies[1].messages;
  assert.equal(second[second.length - 2].role, 'assistant', 'the tool_calls turn must be replayed');
  const toolMsg = second[second.length - 1];
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.match(toolMsg.content, /Portland/);
});

await test('tools are withheld on the final round so the model must answer', async () => {
  const bodies = [];
  // One tool call per allowed round, so the loop actually reaches the last one.
  const inner = fakeOpenAIWithTools([WEATHER_CALL, WEATHER_CALL, WEATHER_CALL, FINAL]);
  const fetchImpl = async (url, init) => {
    if (String(url).includes('openai')) bodies.push(JSON.parse(init.body));
    return inner(url, init);
  };
  const out = await askAgent({ question: 'weather?' }, { env: { OPENAI_API_KEY: 'sk-test' }, fetchImpl });

  assert.ok(bodies[0].tools, 'first round should offer tools');
  assert.equal(bodies[bodies.length - 1].tools, undefined, 'last round must not offer tools');
  assert.match(out.answer, /Overcast/);
});

await test('a failing tool still produces an answer', async () => {
  const inner = fakeOpenAIWithTools([WEATHER_CALL, FINAL]);
  const fetchImpl = async (url, init) => {
    if (String(url).includes('openai')) return inner(url, init);
    return fakeWorld({ weatherFails: true, geocodeFails: true })(url, init);
  };
  const out = await askAgent({ question: 'weather?' }, { env: { OPENAI_API_KEY: 'sk-test' }, fetchImpl });
  assert.ok(out.answer, 'a broken upstream must degrade the answer, not kill the request');
});

await test('no tools are offered when the question needs none', async () => {
  const bodies = [];
  const inner = fakeOpenAIWithTools([FINAL]);
  const fetchImpl = async (url, init) => {
    if (String(url).includes('openai')) bodies.push(JSON.parse(init.body));
    return inner(url, init);
  };
  const out = await askAgent(
    { question: 'what is 2 plus 2' },
    { env: { OPENAI_API_KEY: 'sk-test', OSCAR_DISABLE_TOOLS: '1' }, fetchImpl }
  );
  assert.equal(bodies[0].tools, undefined);
  assert.deepEqual(out.toolsUsed, []);
});

section('coordinates through the API');

await test('flat latitude/longitude from the Shortcut reach the tools', async () => {
  setEnv();
  let seenCtx = null;
  const inner = fakeOpenAIWithTools([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_location', arguments: '{}' } }] },
    FINAL,
  ]);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('nominatim')) seenCtx = String(url);
    return inner(url, init);
  };

  const res = fakeRes();
  await askHandler(
    fakeReq({
      headers: { 'x-oscar-key': 'letmein' },
      body: { question: 'where am I', latitude: 47.6062, longitude: -122.3321 },
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.ok(seenCtx, 'GPS coordinates should have triggered a reverse geocode');
  assert.match(seenCtx, /lat=47.6062/);
  assert.deepEqual(res.json().tools, ['get_location']);
});

await test('a nested location dictionary is accepted too', async () => {
  setEnv();
  let seen = null;
  const inner = fakeOpenAIWithTools([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_location', arguments: '{}' } }] },
    FINAL,
  ]);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('nominatim')) seen = String(url);
    return inner(url, init);
  };

  const res = fakeRes();
  await askHandler(
    fakeReq({
      headers: { 'x-oscar-key': 'letmein' },
      body: { question: 'where am I', location: { latitude: 51.5072, longitude: -0.1276 } },
    }),
    res
  );
  assert.match(seen, /lat=51.5072/);
});

await test('a "lat,lon" string is accepted too', async () => {
  setEnv();
  let seen = null;
  const inner = fakeOpenAIWithTools([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_location', arguments: '{}' } }] },
    FINAL,
  ]);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('nominatim')) seen = String(url);
    return inner(url, init);
  };

  const res = fakeRes();
  await askHandler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'where am I', location: '35.6762,139.6503' } }),
    res
  );
  assert.match(seen, /lat=35.6762/);
});

await test('tool names are logged but coordinates are not', async () => {
  setEnv(DB_ENV);
  const supabase = fakeSupabase();
  const inner = fakeOpenAIWithTools([WEATHER_CALL, FINAL]);
  globalThis.fetch = async (url, init) =>
    String(url).includes('supabase') ? supabase(url, init) : inner(url, init);

  const res = fakeRes();
  await askHandler(
    fakeReq({
      headers: { 'x-oscar-key': 'letmein' },
      body: { question: 'weather?', latitude: 47.6062, longitude: -122.3321 },
    }),
    res
  );

  const row = supabase.calls[0].body;
  assert.deepEqual(row.tools_used, ['get_weather']);
  const serialised = JSON.stringify(row);
  assert.ok(!serialised.includes('47.6062'), 'coordinates must not be written to the database');
});


/* ============================================================ google auth */
section('google auth');

const G_ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token',
};

/** Fake Google: token endpoint plus the three APIs. */
function fakeGoogle(overrides = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const href = String(url);
    let parsedBody = null;
    if (init.body) {
      // The token endpoint is form-encoded, everything else is JSON.
      try { parsedBody = JSON.parse(init.body); } catch { parsedBody = String(init.body); }
    }
    calls.push({ href, method: init.method || 'GET', body: parsedBody, headers: init.headers || {} });
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

    if (href.includes('oauth2.googleapis.com/token')) {
      if (overrides.invalidGrant) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: overrides.token || 'access-123', expires_in: 3600 });
    }
    if (href.includes('calendar/v3')) {
      if (init.method === 'POST') return json({ id: 'evt1', summary: init.body ? JSON.parse(init.body).summary : 'x',
        start: { dateTime: '2026-08-18T14:00:00Z' }, end: { dateTime: '2026-08-18T15:00:00Z' } });
      if (init.method === 'DELETE') return { ok: true, status: 204, text: async () => '' };
      // A URL ending /events/<id> is a single event, not the collection.
      const single = /\/events\/([^/?]+)$/.exec(href.split('?')[0]);
      if (single) return json({ id: single[1], summary: 'Standup', status: 'confirmed',
        start: { dateTime: '2026-08-17T09:00:00-07:00' }, end: { dateTime: '2026-08-17T09:15:00-07:00' } });
      return json({ items: [
        { id: 'e1', summary: 'Standup', start: { dateTime: '2026-08-17T09:00:00-07:00' }, end: { dateTime: '2026-08-17T09:15:00-07:00' }, attendees: [{ email: 'a@b.com' }] },
        { id: 'e2', summary: 'Dentist', start: { date: '2026-08-17' }, end: { date: '2026-08-18' }, location: 'Main St' },
      ] });
    }
    if (href.includes('tasks.googleapis.com')) {
      if (href.includes('users/@me/lists')) return json({ items: [{ id: 'list1', title: 'My Tasks' }, { id: 'list2', title: 'Work' }] });
      if (init.method === 'POST') return json({ id: 't9', title: JSON.parse(init.body).title, due: JSON.parse(init.body).due || null });
      if (init.method === 'DELETE') return { ok: true, status: 204, text: async () => '' };
      if (init.method === 'PATCH') return json({ id: 't1', title: 'Buy milk', status: 'completed' });
      // /lists/<list>/tasks/<id> is one task; /lists/<list>/tasks is the collection.
      const oneTask = /\/tasks\/([^/?]+)$/.exec(href.split('?')[0]);
      if (oneTask && !href.endsWith('/tasks')) {
        return json({ id: oneTask[1], title: 'Buy milk', status: 'needsAction' });
      }
      return json({ items: [
        { id: 't1', title: 'Buy milk', status: 'needsAction' },
        { id: 't2', title: 'File taxes', status: 'needsAction', due: '2026-09-01T00:00:00.000Z' },
      ] });
    }
    if (href.includes('gmail.googleapis.com')) {
      if (href.includes('/messages/send')) return json({ id: 'sent1' });
      if (href.includes('/trash')) return json({ id: 'm1', labelIds: ['TRASH'] });
      if (href.includes('/drafts')) return json({ id: 'draft1' });
      if (href.includes('/messages?')) return json({ messages: [{ id: 'm1' }, { id: 'm2' }] });
      if (href.includes('/messages/')) return json({ id: 'm1', threadId: 'th1', labelIds: ['UNREAD'], snippet: 'hello there',
        payload: { headers: [{ name: 'From', value: 'Jane <jane@example.com>' }, { name: 'Subject', value: 'Lunch?' }, { name: 'Date', value: 'Mon, 17 Aug 2026 09:00:00 -0700' }],
          mimeType: 'text/plain', body: { data: Buffer.from('Are you free for lunch?').toString('base64url') } } });
    }
    throw new Error(`unexpected google url: ${href}`);
  };
  fn.calls = calls;
  return fn;
}

await test('google config requires all three variables', () => {
  assert.equal(googleConfig({}), null);
  assert.equal(googleConfig({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }), null);
  assert.equal(isGoogleConfigured(G_ENV), true);
});

await test('scopes narrow when writes are off', () => {
  const read = scopesFor({});
  const write = scopesFor({ OSCAR_ALLOW_WRITES: '1' });
  assert.ok(read.every((s) => s.includes('readonly')), 'read scopes must all be readonly');
  assert.ok(write.some((s) => s.endsWith('gmail.send')), 'write scopes must include sending');
  assert.ok(!read.some((s) => s.endsWith('gmail.send')));
});

await test('access tokens are cached rather than re-fetched', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  const a = await getAccessToken({ env: G_ENV, fetchImpl });
  const b = await getAccessToken({ env: G_ENV, fetchImpl });
  assert.equal(a, 'access-123');
  assert.equal(b, 'access-123');
  assert.equal(fetchImpl.calls.length, 1, 'second call should have used the cache');
});

await test('an expired cache entry triggers a refresh', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  await getAccessToken({ env: G_ENV, fetchImpl, now: 0 });
  await getAccessToken({ env: G_ENV, fetchImpl, now: 3_600_001 });
  assert.equal(fetchImpl.calls.length, 2);
});

await test('invalid_grant explains the 7-day Testing-mode trap', async () => {
  clearTokenCache();
  await assert.rejects(
    () => getAccessToken({ env: G_ENV, fetchImpl: fakeGoogle({ invalidGrant: true }) }),
    (err) => err instanceof GoogleAuthError && /Testing/.test(err.message) && err.needsReauth
  );
});

await test('missing google config gives an actionable message', async () => {
  clearTokenCache();
  await assert.rejects(
    () => getAccessToken({ env: {}, fetchImpl: fakeGoogle() }),
    (err) => /GOOGLE_CLIENT_ID/.test(err.message)
  );
});

await test('googleFetch attaches the bearer token', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  await googleFetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', {}, { env: G_ENV, fetchImpl });
  const apiCall = fetchImpl.calls.find((c) => c.href.includes('tasks.googleapis'));
  assert.equal(apiCall.headers.authorization, 'Bearer access-123');
});

/* =============================================================== calendar */
section('calendar tool');

await test('date ranges resolve to sensible windows', () => {
  const now = new Date('2026-08-17T12:00:00Z');
  const today = resolveWindow('today', 'UTC', now);
  assert.ok(today.timeMax > today.timeMin);
  const week = resolveWindow('week', 'UTC', now);
  assert.ok(new Date(week.timeMax) - new Date(week.timeMin) > 6 * 864e5);
  const tomorrow = resolveWindow('tomorrow', 'UTC', now);
  assert.match(tomorrow.timeMin, /2026-08-18/);
});

await test('events come back tidied, with all-day events flagged', async () => {
  clearTokenCache();
  const out = await listEventsTool.run({ range: 'today' }, { env: G_ENV, fetchImpl: fakeGoogle(), timeZone: 'America/Los_Angeles' });
  assert.equal(out.count, 2);
  assert.equal(out.events[0].title, 'Standup');
  assert.equal(out.events[1].allDay, true, 'a date-only event must be marked all day');
  assert.equal(out.events[1].location, 'Main St');
});

await test('the calendar query expands recurring events', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  await listEventsTool.run({}, { env: G_ENV, fetchImpl });
  const url = new URL(fetchImpl.calls.find((c) => c.href.includes('calendar')).href);
  assert.equal(url.searchParams.get('singleEvents'), 'true');
  assert.equal(url.searchParams.get('orderBy'), 'startTime');
});

await test('creating an event rejects a backwards time range', async () => {
  clearTokenCache();
  await assert.rejects(
    () => createEventTool.run({ title: 'x', start: '2026-08-18T15:00:00Z', end: '2026-08-18T14:00:00Z' },
      { env: G_ENV, fetchImpl: fakeGoogle() }),
    /end time has to be after/
  );
  await assert.rejects(
    () => createEventTool.run({ title: 'x', start: 'not a date', end: 'also not' },
      { env: G_ENV, fetchImpl: fakeGoogle() }),
    /not valid dates/
  );
});

await test('creating an event posts and confirms', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  const out = await createEventTool.run(
    { title: 'Dinner', start: '2026-08-18T18:00:00-07:00', end: '2026-08-18T20:00:00-07:00' },
    { env: G_ENV, fetchImpl, timeZone: 'America/Los_Angeles' }
  );
  assert.equal(out.created, true);
  const post = fetchImpl.calls.find((c) => c.method === 'POST' && c.href.includes('calendar'));
  assert.equal(post.body.summary, 'Dinner');
  assert.ok(post.body.start.dateTime);
});

/* ================================================================== tasks */
section('tasks tool');

await test('tasks sort dated items first', async () => {
  clearTokenCache(); clearListCache();
  const out = await listTasksTool.run({}, { env: G_ENV, fetchImpl: fakeGoogle() });
  assert.equal(out.list, 'My Tasks');
  assert.equal(out.tasks[0].title, 'File taxes', 'the dated task should sort first');
  assert.equal(out.tasks[0].due, '2026-09-01', 'the meaningless time part must be trimmed');
});

await test('an unknown task list is a clear error, not a silent default', async () => {
  clearTokenCache(); clearListCache();
  await assert.rejects(
    () => listTasksTool.run({ list: 'Nonexistent' }, { env: G_ENV, fetchImpl: fakeGoogle() }),
    /no task list called/
  );
});

await test('a task list is matched loosely by name', async () => {
  clearTokenCache(); clearListCache();
  const out = await listTasksTool.run({ list: 'work' }, { env: G_ENV, fetchImpl: fakeGoogle() });
  assert.equal(out.list, 'Work');
});

await test('due dates are validated and sent as RFC 3339', async () => {
  clearTokenCache(); clearListCache();
  await assert.rejects(
    () => createTaskTool.run({ title: 'x', due: 'next tuesday' }, { env: G_ENV, fetchImpl: fakeGoogle() }),
    /must look like/
  );
  const fetchImpl = fakeGoogle();
  clearListCache();
  await createTaskTool.run({ title: 'Call dentist', due: '2026-09-01' }, { env: G_ENV, fetchImpl });
  const post = fetchImpl.calls.find((c) => c.method === 'POST');
  assert.equal(post.body.due, '2026-09-01T00:00:00.000Z');
});

/* ================================================================== gmail */
section('gmail tool');

await test('email addresses are sanity checked', () => {
  assert.equal(looksLikeEmail('a@b.com'), true);
  assert.equal(looksLikeEmail('not an email'), false);
  assert.equal(looksLikeEmail('a@b'), false);
  assert.equal(looksLikeEmail(''), false);
});

await test('raw messages are valid RFC 2822 and base64url encoded', () => {
  const raw = buildRawMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello there' });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /^To: a@b\.com\r\n/);
  assert.match(decoded, /Subject: Hi\r\n/);
  assert.match(decoded, /\r\n\r\nHello there$/);
  assert.ok(!raw.includes('+') && !raw.includes('/'), 'must be base64URL, not standard base64');
});

await test('non-ASCII subjects are RFC 2047 encoded', () => {
  const decoded = Buffer.from(
    buildRawMessage({ to: 'a@b.com', subject: 'Café ☕', body: 'x' }), 'base64url').toString('utf8');
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
});

await test('HTML-only bodies are stripped to readable text', () => {
  const html = Buffer.from('<html><style>p{color:red}</style><p>Hello <b>you</b></p></html>').toString('base64url');
  const text = extractBody({ mimeType: 'text/html', body: { data: html } });
  assert.match(text, /Hello/);
  assert.ok(!text.includes('<'), 'tags must be gone');
  assert.ok(!text.includes('color:red'), 'style contents must be gone');
});

await test('plain text is preferred over html', () => {
  const text = extractBody({ mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/html', body: { data: Buffer.from('<p>html version</p>').toString('base64url') } },
    { mimeType: 'text/plain', body: { data: Buffer.from('plain version').toString('base64url') } },
  ] });
  assert.equal(text, 'plain version');
});

await test('the send allowlist blocks unlisted recipients', () => {
  const env = { GOOGLE_SEND_ALLOWLIST: 'me@example.com, boss@example.com' };
  assert.equal(checkRecipients(['me@example.com'], env).allowed, true);
  assert.equal(checkRecipients(['ME@EXAMPLE.COM'], env).allowed, true, 'should be case insensitive');
  const blocked = checkRecipients(['stranger@evil.com'], env);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /not permitted/);
  assert.equal(checkRecipients(['anyone@anywhere.com'], {}).allowed, true, 'unset means anyone');
});

await test('send_email refuses a recipient outside the allowlist', async () => {
  clearTokenCache();
  await assert.rejects(
    () => sendEmailTool.run({ to: 'stranger@evil.com', subject: 'x', body: 'y' },
      { env: { ...G_ENV, GOOGLE_SEND_ALLOWLIST: 'me@example.com' }, fetchImpl: fakeGoogle() }),
    /not permitted/
  );
});

await test('searching email returns headers without bodies', async () => {
  clearTokenCache();
  const out = await searchEmailTool.run({ query: 'is:unread', limit: 2 }, { env: G_ENV, fetchImpl: fakeGoogle() });
  assert.equal(out.count, 2);
  assert.equal(out.messages[0].subject, 'Lunch?');
  assert.equal(out.messages[0].unread, true);
  assert.equal(out.messages[0].body, undefined, 'search must not ship full bodies');
});

/* ========================================================== the write gate */
section('write gate');

await test('write tools are hidden without permission', () => {
  const env = { ...G_ENV, OSCAR_ALLOW_WRITES: '1' };
  const readOnly = availableTools({ canWrite: false }, env).map((t) => t.name);
  const withWrite = availableTools({ canWrite: true }, env).map((t) => t.name);

  for (const name of ['send_email', 'draft_email', 'create_event', 'create_task', 'complete_task']) {
    assert.ok(!readOnly.includes(name), `${name} must be hidden from a read-only request`);
    assert.ok(withWrite.includes(name), `${name} should appear with write permission`);
  }
  for (const name of ['search_email', 'list_events', 'list_tasks', 'get_weather']) {
    assert.ok(readOnly.includes(name), `${name} should always be available`);
  }
});

await test('the master switch overrides per-request permission', () => {
  const names = availableTools({ canWrite: true }, { ...G_ENV }).map((t) => t.name);
  assert.ok(!names.includes('send_email'), 'without OSCAR_ALLOW_WRITES=1 nothing may write');
});

await test('google tools disappear entirely when google is not connected', () => {
  const names = availableTools({ canWrite: true }, { OSCAR_ALLOW_WRITES: '1' }).map((t) => t.name);
  assert.ok(!names.includes('list_events'));
  assert.ok(names.includes('get_weather'), 'non-google tools should be unaffected');
});

await test('runTool refuses a write tool even if it is called directly', async () => {
  const out = await runTool('send_email', '{"to":"a@b.com","subject":"x","body":"y"}',
    { env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: false, fetchImpl: fakeGoogle() });
  assert.match(out.error, /write permission/, 'the gate must hold at execution time too');
});

await test('the schema list sent to the model excludes write tools', () => {
  const env = { ...G_ENV, OSCAR_ALLOW_WRITES: '1' };
  const names = toolSchemas({ canWrite: false }, env).map((s) => s.function.name);
  assert.ok(!names.includes('send_email'));
  assert.ok(names.includes('search_email'));
});

section('write authority over HTTP');

await test('the shortcut key alone cannot write', async () => {
  setEnv({ ...G_ENV, OSCAR_ALLOW_WRITES: '1', OSCAR_WRITE_SECRET: 'write-me' });
  globalThis.fetch = fakeOpenAIWithTools([FINAL]);
  const res = fakeRes();
  await askHandler(fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'hi' } }), res);
  assert.equal(res.json().canWrite, false, 'the read key must never grant write authority');
});

await test('the write header grants write authority', async () => {
  setEnv({ ...G_ENV, OSCAR_ALLOW_WRITES: '1', OSCAR_WRITE_SECRET: 'write-me' });
  globalThis.fetch = fakeOpenAIWithTools([FINAL]);
  const res = fakeRes();
  await askHandler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein', 'x-oscar-write': 'write-me' }, body: { question: 'hi' } }),
    res
  );
  assert.equal(res.json().canWrite, true);
});

await test('a wrong write header does not grant authority', async () => {
  setEnv({ ...G_ENV, OSCAR_ALLOW_WRITES: '1', OSCAR_WRITE_SECRET: 'write-me' });
  globalThis.fetch = fakeOpenAIWithTools([FINAL]);
  const res = fakeRes();
  await askHandler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein', 'x-oscar-write': 'guess' }, body: { question: 'hi' } }),
    res
  );
  assert.equal(res.json().canWrite, false);
});

await test('a full browser login grants write authority', async () => {
  setEnv({ ...G_ENV, OSCAR_ALLOW_WRITES: '1' });
  globalThis.fetch = fakeOpenAIWithTools([FINAL]);
  const res = fakeRes();
  await askHandler(
    fakeReq({ cookie: `oscar_session=${createSession('owner@example.com', SECRET)}`, body: { question: 'hi' } }),
    res
  );
  assert.equal(res.json().canWrite, true, 'password plus emailed code is the strongest proof we have');
});

await test('the master switch off means nobody writes, even signed in', async () => {
  setEnv({ ...G_ENV });
  globalThis.fetch = fakeOpenAIWithTools([FINAL]);
  const res = fakeRes();
  await askHandler(
    fakeReq({ cookie: `oscar_session=${createSession('owner@example.com', SECRET)}`, body: { question: 'hi' } }),
    res
  );
  assert.equal(res.json().canWrite, false);
});


/* ========================================================== confirmation */
section('confirmation tokens');

const C_ENV = { OSCAR_SESSION_SECRET: SECRET };

await test('a confirmation token round-trips', () => {
  const token = createConfirmToken(
    { tool: 'delete_event', args: { id: 'evt1' }, prompt: 'Delete "Dentist"?' }, C_ENV);
  const back = readConfirmToken(token, C_ENV);
  assert.equal(back.tool, 'delete_event');
  assert.equal(back.args.id, 'evt1');
  assert.match(back.prompt, /Dentist/);
});

await test('a token cannot be edited to target something else', () => {
  const token = createConfirmToken(
    { tool: 'delete_event', args: { id: 'harmless' }, prompt: 'x' }, C_ENV);
  const [data, sig] = token.split('.');
  const evil = Buffer.from(JSON.stringify({
    t: 'confirm', tool: 'delete_event', args: { id: 'something-precious' },
    exp: Date.now() + 60000,
  })).toString('base64url');

  assert.throws(() => readConfirmToken(`${evil}.${sig}`, C_ENV), ConfirmError,
    'a re-pointed token must not verify');
  assert.equal(readConfirmToken(`${data}.${sig}`, C_ENV).args.id, 'harmless');
});

await test('a token signed with a different secret is refused', () => {
  const token = createConfirmToken({ tool: 'delete_event', args: {}, prompt: 'x' },
    { OSCAR_SESSION_SECRET: 'someone-elses-secret' });
  assert.throws(() => readConfirmToken(token, C_ENV), ConfirmError);
});

await test('an expired token is refused with a readable message', () => {
  const token = createConfirmToken({ tool: 'delete_event', args: {}, prompt: 'x' },
    C_ENV, Date.now() - 10 * 60 * 1000);
  assert.throws(() => readConfirmToken(token, C_ENV), /expired/);
});

await test('a missing token is refused', () => {
  assert.throws(() => readConfirmToken(undefined, C_ENV), ConfirmError);
  assert.throws(() => readConfirmToken('', C_ENV), ConfirmError);
});

await test('only clear agreement counts as yes', () => {
  for (const yes of ['Yes', 'yes', 'YES', 'y', true, 1, 'confirm', 'delete', 'ok']) {
    assert.equal(isAffirmative(yes), true, `${yes} should be a yes`);
  }
  for (const no of ['No', 'n', false, 0, '', null, undefined, 'maybe', 'cancel', 'Nope']) {
    assert.equal(isAffirmative(no), false, `${JSON.stringify(no)} must NOT be a yes`);
  }
});

section('delete tools ask first');

await test('the delete tools are all marked as needing confirmation', () => {
  for (const name of ['delete_event', 'delete_task', 'trash_email']) {
    const tool = getTool(name);
    assert.ok(tool, `${name} should be registered`);
    assert.equal(tool.confirm, true, `${name} must require confirmation`);
    assert.equal(tool.writes, true, `${name} must be a write tool`);
    assert.equal(typeof tool.describe, 'function', `${name} needs a describe step`);
  }
});

await test('send_email confirmation is opt-in via OSCAR_CONFIRM_SEND', () => {
  assert.equal(needsConfirmation(getTool('send_email'), {}), false);
  assert.equal(needsConfirmation(getTool('send_email'), { OSCAR_CONFIRM_SEND: '1' }), true);
  assert.equal(needsConfirmation(getTool('delete_event'), {}), true, 'deletes always confirm');
});

await test('calling a delete tool describes instead of deleting', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  const out = await runTool('delete_event', '{"id":"e1"}', {
    env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: true, fetchImpl,
    timeZone: 'America/Los_Angeles',
  });

  assert.ok(out.confirmation, 'should return a confirmation request');
  assert.equal(out.confirmation.tool, 'delete_event');
  assert.match(out.confirmation.prompt, /Standup/, 'the prompt must name the event');
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'DELETE'),
    'NOTHING may be deleted before confirmation');
});

await test('the task delete prompt names the task and list', async () => {
  clearTokenCache(); clearListCache();
  const fetchImpl = fakeGoogle();
  const out = await runTool('delete_task', '{"id":"t1"}', {
    env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: true, fetchImpl });
  assert.match(out.confirmation.prompt, /Buy milk/);
  assert.match(out.confirmation.prompt, /My Tasks/);
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'DELETE'));
});

await test('the email trash prompt names the subject and sender', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  const out = await runTool('trash_email', '{"id":"m1"}', {
    env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: true, fetchImpl });
  assert.match(out.confirmation.prompt, /Lunch\?/);
  assert.match(out.confirmation.prompt, /jane@example\.com/);
});

await test('confirmed: true is what actually performs the delete', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  const out = await runTool('delete_event', { id: 'e1' }, {
    env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: true, confirmed: true, fetchImpl });

  assert.ok(out.result && out.result.deleted, 'should have deleted');
  assert.ok(fetchImpl.calls.some((c) => c.method === 'DELETE'), 'a DELETE should have been sent');
});

await test('trash uses Gmail /trash, never permanent /delete', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  await runTool('trash_email', { id: 'm1' }, {
    env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: true, confirmed: true, fetchImpl });

  assert.ok(fetchImpl.calls.some((c) => c.href.includes('/trash')), 'should call /trash');
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'DELETE'),
    'a permanent delete must never be issued for mail');
});

await test('a delete tool still needs write permission', async () => {
  const out = await runTool('delete_event', '{"id":"e1"}', {
    env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: false, fetchImpl: fakeGoogle() });
  assert.match(out.error, /write permission/);
});

section('confirmation through the agent');

const DELETE_CALL = {
  role: 'assistant', content: null,
  tool_calls: [{ id: 'c1', type: 'function',
    function: { name: 'delete_event', arguments: '{"id":"e1"}' } }],
};

await test('the agent stops and returns the prompt verbatim', async () => {
  clearTokenCache();
  const inner = fakeOpenAIWithTools([DELETE_CALL, FINAL]);
  const openaiCalls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('openai')) { openaiCalls.push(1); return inner(url, init); }
    return fakeGoogle()(url, init);
  };

  const out = await askAgent(
    { question: 'delete the standup', canWrite: true, timeZone: 'America/Los_Angeles' },
    { env: { ...G_ENV, OPENAI_API_KEY: 'sk-test', OSCAR_ALLOW_WRITES: '1' }, fetchImpl }
  );

  assert.ok(out.pendingConfirmation, 'a confirmation should be pending');
  assert.match(out.answer, /Standup/, 'the answer IS the prompt, unparaphrased');
  assert.equal(openaiCalls.length, 1, 'must not spend a second model round trip on this');
});

section('the confirm endpoint');

function confirmEnv() {
  setEnv({ ...G_ENV, OSCAR_ALLOW_WRITES: '1', OSCAR_WRITE_SECRET: 'write-me' });
}

await test('a valid yes performs the action', async () => {
  confirmEnv();
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  globalThis.fetch = fetchImpl;
  const token = createConfirmToken(
    { tool: 'delete_event', args: { id: 'e1' }, prompt: 'Delete "Standup"?' }, process.env);

  const res = fakeRes();
  await confirmHandler(fakeReq({ url: '/api/confirm',
    headers: { 'x-oscar-key': 'letmein', 'x-oscar-write': 'write-me' },
    body: { token, confirm: 'Yes' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().done, true);
  assert.ok(fetchImpl.calls.some((c) => c.method === 'DELETE'));
});

await test('answering no changes nothing and is not an error', async () => {
  confirmEnv();
  const fetchImpl = fakeGoogle();
  globalThis.fetch = fetchImpl;
  const token = createConfirmToken({ tool: 'delete_event', args: { id: 'e1' }, prompt: 'x' }, process.env);

  const res = fakeRes();
  await confirmHandler(fakeReq({ url: '/api/confirm',
    headers: { 'x-oscar-key': 'letmein', 'x-oscar-write': 'write-me' },
    body: { token, confirm: 'No' } }), res);

  assert.equal(res.statusCode, 200, 'saying no is a success, not a failure');
  assert.equal(res.json().cancelled, true);
  assert.equal(fetchImpl.calls.length, 0, 'Google must not be touched at all');
});

await test('a garbled confirm answer is treated as no', async () => {
  confirmEnv();
  const fetchImpl = fakeGoogle();
  globalThis.fetch = fetchImpl;
  const token = createConfirmToken({ tool: 'delete_event', args: { id: 'e1' }, prompt: 'x' }, process.env);

  const res = fakeRes();
  await confirmHandler(fakeReq({ url: '/api/confirm',
    headers: { 'x-oscar-key': 'letmein', 'x-oscar-write': 'write-me' },
    body: { token, confirm: 'uhh maybe' } }), res);

  assert.equal(res.json().cancelled, true, 'anything unrecognised must mean no');
  assert.equal(fetchImpl.calls.length, 0);
});

await test('the read key alone cannot redeem a confirmation', async () => {
  confirmEnv();
  const fetchImpl = fakeGoogle();
  globalThis.fetch = fetchImpl;
  const token = createConfirmToken({ tool: 'delete_event', args: { id: 'e1' }, prompt: 'x' }, process.env);

  const res = fakeRes();
  await confirmHandler(fakeReq({ url: '/api/confirm',
    headers: { 'x-oscar-key': 'letmein' },   // no write header
    body: { token, confirm: 'Yes' } }), res);

  assert.equal(res.statusCode, 403, 'a captured token must be useless without write authority');
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'DELETE'));
});

await test('an unauthenticated confirm is refused', async () => {
  confirmEnv();
  globalThis.fetch = fakeGoogle();
  const token = createConfirmToken({ tool: 'delete_event', args: { id: 'e1' }, prompt: 'x' }, process.env);
  const res = fakeRes();
  await confirmHandler(fakeReq({ url: '/api/confirm', body: { token, confirm: 'Yes' } }), res);
  assert.equal(res.statusCode, 401);
});

await test('a forged token is refused before anything happens', async () => {
  confirmEnv();
  const fetchImpl = fakeGoogle();
  globalThis.fetch = fetchImpl;
  const res = fakeRes();
  await confirmHandler(fakeReq({ url: '/api/confirm',
    headers: { 'x-oscar-key': 'letmein', 'x-oscar-write': 'write-me' },
    body: { token: 'made.up', confirm: 'Yes' } }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(fetchImpl.calls.length, 0);
});

await test('ask returns a signed token the confirm endpoint accepts', async () => {
  confirmEnv();
  clearTokenCache();
  const inner = fakeOpenAIWithTools([DELETE_CALL, FINAL]);
  const google = fakeGoogle();
  globalThis.fetch = async (url, init) =>
    String(url).includes('openai') ? inner(url, init) : google(url, init);

  const askRes = fakeRes();
  await askHandler(fakeReq({
    headers: { 'x-oscar-key': 'letmein', 'x-oscar-write': 'write-me' },
    body: { question: 'delete the standup', tz: 'America/Los_Angeles' },
  }), askRes);

  const asked = askRes.json();
  assert.equal(asked.needsConfirmation, true);
  assert.ok(asked.confirmToken, 'a token must be issued');
  assert.match(asked.confirmPrompt, /Standup/);
  assert.ok(!google.calls.some((c) => c.method === 'DELETE'), 'phase one must not delete');

  // Phase two, using exactly what the phone would send back.
  const confirmRes = fakeRes();
  await confirmHandler(fakeReq({ url: '/api/confirm',
    headers: { 'x-oscar-key': 'letmein', 'x-oscar-write': 'write-me' },
    body: { token: asked.confirmToken, confirm: 'Yes' } }), confirmRes);

  assert.equal(confirmRes.statusCode, 200);
  assert.equal(confirmRes.json().done, true);
  assert.ok(google.calls.some((c) => c.method === 'DELETE'), 'phase two deletes');
});

await test('a normal answer carries needsConfirmation false', async () => {
  confirmEnv();
  globalThis.fetch = fakeOpenAIWithTools([FINAL]);
  const res = fakeRes();
  await askHandler(fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'hi' } }), res);
  assert.equal(res.json().needsConfirmation, false,
    'unchanged Shortcuts must still see a sane field');
});


section('who gets asked to confirm');

await test('the Shortcut path asks before deleting', async () => {
  confirmEnv();
  clearTokenCache();
  const inner = fakeOpenAIWithTools([DELETE_CALL, FINAL]);
  const google = fakeGoogle();
  globalThis.fetch = async (url, init) =>
    String(url).includes('openai') ? inner(url, init) : google(url, init);

  const res = fakeRes();
  await askHandler(fakeReq({
    headers: { 'x-oscar-key': 'letmein', 'x-oscar-write': 'write-me' },
    body: { question: 'delete the standup', tz: 'America/Los_Angeles' },
  }), res);

  assert.equal(res.json().needsConfirmation, true, 'dictation must be confirmed');
  assert.ok(!google.calls.some((c) => c.method === 'DELETE'), 'nothing may be deleted yet');
});

await test('typed web input deletes straight away', async () => {
  confirmEnv();
  clearTokenCache();
  const inner = fakeOpenAIWithTools([DELETE_CALL, FINAL]);
  const google = fakeGoogle();
  globalThis.fetch = async (url, init) =>
    String(url).includes('openai') ? inner(url, init) : google(url, init);

  const res = fakeRes();
  await askHandler(fakeReq({
    cookie: `oscar_session=${createSession('owner@example.com', SECRET)}`,
    body: { question: 'delete the standup', tz: 'America/Los_Angeles' },
  }), res);

  const data = res.json();
  assert.equal(data.needsConfirmation, false, 'typing on the web should not need a second click');
  assert.ok(google.calls.some((c) => c.method === 'DELETE'), 'it should just delete');
});

await test('dictating in the browser still asks', async () => {
  confirmEnv();
  clearTokenCache();
  const inner = fakeOpenAIWithTools([DELETE_CALL, FINAL]);
  const google = fakeGoogle();
  globalThis.fetch = async (url, init) =>
    String(url).includes('openai') ? inner(url, init) : google(url, init);

  const res = fakeRes();
  await askHandler(fakeReq({
    cookie: `oscar_session=${createSession('owner@example.com', SECRET)}`,
    body: { question: 'delete the standup', dictated: true, tz: 'America/Los_Angeles' },
  }), res);

  assert.equal(res.json().needsConfirmation, true, 'the microphone is the risky input anywhere');
  assert.ok(!google.calls.some((c) => c.method === 'DELETE'));
});

await test('OSCAR_CONFIRM_ALWAYS forces confirmation on typed web input too', async () => {
  confirmEnv();
  process.env.OSCAR_CONFIRM_ALWAYS = '1';
  clearTokenCache();
  const inner = fakeOpenAIWithTools([DELETE_CALL, FINAL]);
  const google = fakeGoogle();
  globalThis.fetch = async (url, init) =>
    String(url).includes('openai') ? inner(url, init) : google(url, init);

  const res = fakeRes();
  await askHandler(fakeReq({
    cookie: `oscar_session=${createSession('owner@example.com', SECRET)}`,
    body: { question: 'delete the standup' },
  }), res);

  assert.equal(res.json().needsConfirmation, true);
  assert.ok(!google.calls.some((c) => c.method === 'DELETE'));
  delete process.env.OSCAR_CONFIRM_ALWAYS;
});

await test('runTool defaults to asking when no policy is given', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  const out = await runTool('delete_event', '{"id":"e1"}', {
    env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: true, fetchImpl,
  });
  assert.ok(out.confirmation, 'a caller that forgets the flag must get the safe behaviour');
});

await test('requireConfirm false skips the gate', async () => {
  clearTokenCache();
  const fetchImpl = fakeGoogle();
  const out = await runTool('delete_event', '{"id":"e1"}', {
    env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: true, requireConfirm: false, fetchImpl,
  });
  assert.ok(out.result && out.result.deleted);
  assert.ok(fetchImpl.calls.some((c) => c.method === 'DELETE'));
});

await test('skipping confirmation still requires write permission', async () => {
  const fetchImpl = fakeGoogle();
  const out = await runTool('delete_event', '{"id":"e1"}', {
    env: { ...G_ENV, OSCAR_ALLOW_WRITES: '1' }, canWrite: false, requireConfirm: false, fetchImpl,
  });
  assert.match(out.error, /write permission/, 'the write gate is independent of confirmation');
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'DELETE'));
});

console.log(`\n${passed} passing${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
