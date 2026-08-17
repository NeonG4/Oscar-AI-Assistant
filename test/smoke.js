/**
 * test/smoke.js — run with `npm test` (no dependencies, no network).
 *
 * Exercises the agent and the HTTP handler against a fake OpenAI so you can
 * confirm the request and response shapes before spending a single token.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { askAgent, clampWords, parseModelPayload, AgentError } from '../lib/agent.js';
import handler from '../api/ask.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

/** Minimal stand-in for the OpenAI endpoint. */
function fakeOpenAI(content, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const payload =
      status === 200
        ? { model: 'fake-model', usage: { total_tokens: 42 }, choices: [{ message: { content } }] }
        : { error: { message: content } };
    return {
      ok: status === 200,
      status,
      text: async () => JSON.stringify(payload),
    };
  };
  fn.calls = calls;
  return fn;
}

/** Minimal stand-in for a Vercel req/res pair. */
function fakeReq({ method = 'POST', url = '/api/ask', headers = {}, body } = {}) {
  const stream = new PassThrough();
  if (body !== undefined) stream.end(typeof body === 'string' ? body : JSON.stringify(body));
  else stream.end();
  return Object.assign(stream, { method, url, headers });
}

function fakeRes() {
  const res = {
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
  };
  return res;
}

const GOOD = JSON.stringify({
  title: 'Soft boiled egg',
  answer: 'Six minutes in already-boiling water gives a runny yolk. Chill it right after.',
  detail: 'Seven minutes for a jammy centre, nine for fully set.',
});

console.log('\noscar smoke tests\n');

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
  assert.ok(out.elapsedMs >= 0);
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

await test('handler returns the notification shape', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OSCAR_SHARED_SECRET = 'letmein';
  globalThis.fetch = fakeOpenAI(GOOD);

  const res = fakeRes();
  await handler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'boil an egg?' } }),
    res
  );

  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(typeof data.answer, 'string');
  assert.equal(typeof data.title, 'string');
  assert.ok(data.speak.includes('Six minutes'));
});

await test('handler rejects a bad key', async () => {
  const res = fakeRes();
  await handler(fakeReq({ headers: { 'x-oscar-key': 'nope' }, body: { question: 'hi' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).ok, false);
});

await test('handler accepts a plain-text body', async () => {
  globalThis.fetch = fakeOpenAI(GOOD);
  const res = fakeRes();
  await handler(
    fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: 'what time is it in tokyo' }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).question, 'what time is it in tokyo');
});

await test('handler supports GET for browser checks', async () => {
  globalThis.fetch = fakeOpenAI(GOOD);
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', url: '/api/ask?q=hello&key=letmein' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

await test('errors still come back as readable notification text', async () => {
  globalThis.fetch = fakeOpenAI('insufficient_quota', { status: 429 });
  const res = fakeRes();
  await handler(fakeReq({ headers: { 'x-oscar-key': 'letmein' }, body: { question: 'hi' } }), res);
  assert.equal(res.statusCode, 429);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, false);
  assert.match(data.answer, /insufficient_quota/);
});

await test('handler forwards the tz field into the prompt', async () => {
  const spy = fakeOpenAI(GOOD);
  globalThis.fetch = spy;
  const res = fakeRes();
  await handler(
    fakeReq({
      headers: { 'x-oscar-key': 'letmein' },
      body: { question: 'what time is it', tz: 'America/Los_Angeles' },
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.match(spy.calls[0].body.messages[0].content, /America\/Los_Angeles/);
});

console.log(`\n${passed} passing${process.exitCode ? ' (with failures)' : ''}\n`);
