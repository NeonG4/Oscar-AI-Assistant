/**
 * api/questions.js
 * ----------------------------------------------------------------------------
 * The things Oscar is waiting to hear from you.
 *
 *   GET  /api/questions                      -> everything still unanswered
 *   POST /api/questions { id, answer }       -> answer one, and wake its run up
 *
 * AUTH IS SESSION-ONLY, like /api/history and /api/push. These questions are
 * the contents of your unfinished work, and answering one resumes a run that
 * can write files and spend credit. The Shortcut key lives in plain text on a
 * phone and is not enough for either.
 *
 * WHY ANSWERING TWICE IS SAFE
 *
 * Tapping a notification twice is an entirely ordinary thing to do, and the
 * consequence here would be resuming the same run twice — two parallel
 * continuations of one conversation, both writing files. So the answer is
 * recorded with a `status=pending` filter that matches nothing the second time,
 * and only a genuine first answer goes on to wake the job. The second tap gets
 * a calm "already answered" rather than an error or a duplicate run.
 */

import { getSession } from '../lib/auth.js';
import { applyCors, readBody, send } from '../lib/http.js';
import {
  pendingQuestions,
  answerQuestion,
  getQuestion,
  isQuestionsConfigured,
  QuestionError,
} from '../lib/questions.js';
import { loadJob, updateJob, continueJob, JobError } from '../lib/jobs.js';
import { resumeWithAnswer } from '../lib/agent.js';
import { resumeMissionWithAnswer, isMissionState } from '../lib/missions.js';

/**
 * Put the answer into the parked run and set it going again.
 *
 * Deliberately tolerant: a question whose job has since finished, failed or
 * been cleaned away is not an error. The answer is already saved, and telling
 * someone their reply "failed" when it was simply no longer needed would be
 * both alarming and untrue.
 */
async function wakeJob(question) {
  if (!question.jobId) return { resumed: false, reason: 'not attached to a run' };

  let job;
  try {
    job = await loadJob(question.jobId, {});
  } catch {
    return { resumed: false, reason: 'that run is gone' };
  }

  if (job.status !== 'awaiting_answer') {
    return { resumed: false, reason: `that run is ${job.status}` };
  }
  if (!job.state) return { resumed: false, reason: 'that run has no saved state' };

  let state;
  try {
    state = isMissionState(job.state)
      ? resumeMissionWithAnswer(job.state, question.answer)
      : resumeWithAnswer(job.state, question.answer);
  } catch (err) {
    return { resumed: false, reason: (err && err.message) || 'could not resume that run' };
  }

  await updateJob(
    question.jobId,
    { status: 'running', state, question_id: null },
    {}
  );

  // Fire and forget, exactly as /api/ask does when starting a job. Awaiting it
  // would mean holding this response open for the whole next step.
  const handedOff = continueJob(question.jobId, {});
  return { resumed: true, continued: handedOff };
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (!getSession(req)) {
    return send(res, 401, { ok: false, error: 'Sign in to see questions.' });
  }

  if (!isQuestionsConfigured()) {
    return send(res, 200, {
      ok: true,
      configured: false,
      questions: [],
      error: 'No database is configured, so Oscar cannot save questions.',
    });
  }

  try {
    if (req.method === 'GET') {
      const questions = await pendingQuestions({});
      return send(res, 200, { ok: true, configured: true, questions });
    }

    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use GET or POST.' });

    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (!id) return send(res, 400, { ok: false, error: 'Which question?' });

    const answered = await answerQuestion(id, body.answer, {});

    if (!answered) {
      // Either already answered or never pending. Say which, calmly.
      const existing = await getQuestion(id, {}).catch(() => null);
      return send(res, 200, {
        ok: true,
        alreadyAnswered: true,
        question: existing || undefined,
        note: existing
          ? `That one was already ${existing.status}.`
          : 'That question is no longer open.',
      });
    }

    const woken = await wakeJob(answered);

    return send(res, 200, {
      ok: true,
      answered: true,
      question: answered,
      ...woken,
    });
  } catch (err) {
    const status = err instanceof QuestionError || err instanceof JobError ? err.status || 500 : 500;
    const message =
      err instanceof QuestionError || err instanceof JobError
        ? err.message
        : 'That question request failed.';
    console.error('[oscar] questions:', err);
    return send(res, status, { ok: false, error: message });
  }
}
