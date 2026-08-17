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
import askHandler from '../api/ask.js';
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

console.log(`\n${passed} passing${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
