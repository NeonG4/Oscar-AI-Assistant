/**
 * lib/questions.js
 * ----------------------------------------------------------------------------
 * Things Oscar has stopped to ask you.
 *
 * The inverse of the rest of the system. Everywhere else you ask and Oscar
 * answers; here a run hits something it genuinely cannot decide, writes the
 * question down, notifies you, and sleeps. Your answer wakes it up where it
 * stopped.
 *
 * WHY A RUN SHOULD BE ABLE TO STOP AND ASK
 *
 * The alternative is worse in both directions. A model that never asks guesses,
 * and a confident wrong guess ten steps into a mission wastes everything after
 * it. A model that asks constantly is a chat window with extra latency — you
 * may as well have done it yourself.
 *
 * So the tool's description is written to make asking expensive-sounding and
 * rare, and everything here assumes a question is a real interruption of a real
 * person: it survives a closed laptop, it is answerable from a phone in one
 * tap when there are options, and it never silently expires mid-run.
 */

import { dbRequest, isConfigured } from './db.js';

export { isConfigured as isQuestionsConfigured };

/** Longest a run will wait. Past this the question is stale and so is the run. */
export const ANSWER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class QuestionError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'QuestionError';
    this.status = status;
  }
}

function tidy(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    question: row.question,
    options: Array.isArray(row.options) ? row.options : undefined,
    context: row.context || undefined,
    answer: row.answer || undefined,
    jobId: row.job_id || undefined,
    createdAt: row.created_at,
    answeredAt: row.answered_at || undefined,
  };
}

export { tidy as tidyQuestion };

export async function createQuestion(input, deps = {}) {
  if (!isConfigured(deps.env || process.env)) {
    throw new QuestionError('No database is configured, so I cannot save a question.', 503);
  }

  const question = String(input.question || '').trim();
  if (!question) throw new QuestionError('A question needs text.', 400);

  // Options are a convenience, not a contract — a long list of them on a phone
  // is worse than a plain text box, so they are capped rather than trusted.
  const options = Array.isArray(input.options)
    ? input.options.map((o) => String(o).slice(0, 120)).filter(Boolean).slice(0, 6)
    : null;

  const row = {
    question: question.slice(0, 1000),
    options: options && options.length ? options : null,
    context: input.context ? String(input.context).slice(0, 500) : null,
    job_id: input.jobId || null,
    status: 'pending',
  };

  const result = await dbRequest(
    'questions',
    { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row) },
    deps
  );
  if (!result.ok) throw new QuestionError(`Could not save the question: ${result.error || result.status}`);

  const saved = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!saved || !saved.id) throw new QuestionError('The database did not return a question id.');
  return tidy(saved);
}

export async function getQuestion(id, deps = {}) {
  const result = await dbRequest(
    `questions?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { method: 'GET' },
    deps
  );
  if (!result.ok) throw new QuestionError(`Could not load the question: ${result.error || result.status}`);
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row) throw new QuestionError('No question with that id.', 404);
  return tidy(row);
}

/** Everything Oscar is currently waiting on, newest first. */
export async function pendingQuestions(deps = {}) {
  if (!isConfigured(deps.env || process.env)) return [];
  const result = await dbRequest(
    'questions?select=*&status=eq.pending&order=created_at.desc&limit=20',
    { method: 'GET' },
    deps
  );
  if (!result.ok) throw new QuestionError(`Could not list questions: ${result.error || result.status}`);
  return (Array.isArray(result.data) ? result.data : []).map(tidy);
}

/**
 * Record an answer.
 *
 * The `status=eq.pending` filter is what makes this safe to call twice: the
 * second call matches nothing and returns null, rather than overwriting an
 * answer and resuming a run that is already going. Two taps on a notification
 * is a completely ordinary thing for a person to do.
 *
 * @returns {Promise<object|null>} the answered question, or null if it wasn't pending
 */
export async function answerQuestion(id, answer, deps = {}) {
  const text = String(answer == null ? '' : answer).trim();
  if (!text) throw new QuestionError('An answer cannot be empty.', 400);

  const result = await dbRequest(
    `questions?id=eq.${encodeURIComponent(id)}&status=eq.pending`,
    {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({
        answer: text.slice(0, 2000),
        status: 'answered',
        answered_at: new Date().toISOString(),
      }),
    },
    deps
  );
  if (!result.ok) throw new QuestionError(`Could not save the answer: ${result.error || result.status}`);

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return row ? tidy(row) : null;
}

/** Give up on a question — the run it belonged to is gone. */
export async function cancelQuestionsFor(jobId, deps = {}) {
  if (!jobId) return false;
  await dbRequest(
    `questions?job_id=eq.${encodeURIComponent(jobId)}&status=eq.pending`,
    {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'cancelled' }),
    },
    deps
  ).catch(() => {});
  return true;
}
