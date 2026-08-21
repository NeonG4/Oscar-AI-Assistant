/**
 * lib/tasklist.js
 * ----------------------------------------------------------------------------
 * The task list of a single run: what Oscar decided to do, and how far through
 * it he is.
 *
 * WHOSE LIST IS WHOSE
 *
 * Three things in this system are a list of steps, and the word for each one
 * says who it belongs to:
 *
 *   task    Oscar's own. Made at the start of a run to show his working, and
 *           thrown away with the run. This file.
 *   plan    the user's. Lives in the database, outlives the run that made it,
 *           and can be ticked off next week. lib/plans.js.
 *   to-do   the user's as well, but kept in their Google account rather than
 *           ours. lib/tools/tasks.js.
 *
 * So a TASK is always Oscar's, and only tasks are his to invent, reorder and
 * discard. The other two belong to someone else and are only ever touched
 * because they asked.
 *
 * That difference matters because a task list must work when nothing else is
 * configured. There is no Supabase table behind this, no write permission
 * needed — the list lives inside the agent's own state, which means Oscar can
 * always show his working even on a bare deployment with no database at all.
 *
 * Everything here is pure and plain-JSON: the state it edits gets serialised
 * into `jobs.state` between serverless invocations, so no Dates, no classes.
 */

/** Beyond this a task list has stopped being a summary and become a monologue. */
export const MAX_TASKS = 12;

/** One task title, trimmed to something that fits on a phone screen. */
const TITLE_LIMIT = 120;
const NOTE_LIMIT = 200;

/**
 * Accept what a model actually sends and return the canonical shape.
 *
 * Models are inconsistent about whether a list of things is a list of strings
 * or a list of objects, so both are accepted. Numbering is assigned here rather
 * than taken from the input: the model's own numbering is the single most
 * common thing it gets wrong (duplicates, gaps, starting at zero), and every
 * later `finish_task 3` depends on it being right.
 *
 * @param {Array<string|{title?: string, task?: string, notes?: string}>} input
 * @returns {Array<{n: number, title: string, done: boolean, note?: string}>}
 */
export function normalizeTasks(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry) => {
      if (typeof entry === 'string') return { title: entry.trim() };
      if (entry && typeof entry === 'object') {
        return {
          title: String(entry.title || entry.task || entry.name || '').trim(),
          note: entry.notes || entry.note ? String(entry.notes || entry.note).trim() : undefined,
        };
      }
      return { title: '' };
    })
    .filter((task) => task.title)
    .slice(0, MAX_TASKS)
    .map((task, index) => ({
      n: index + 1,
      title: task.title.slice(0, TITLE_LIMIT),
      done: false,
      ...(task.note ? { note: task.note.slice(0, NOTE_LIMIT) } : {}),
    }));
}

/**
 * Tick one task off.
 *
 * Out-of-range numbers are ignored rather than throwing: this is driven by a
 * model, and "finish task 9 of 5" should cost a wasted call, not the run.
 * Returns a NEW array — the caller stores it on a fresh state object.
 */
export function markTaskDone(tasks, n, note) {
  const number = Number(n);
  if (!Array.isArray(tasks) || !Number.isFinite(number)) return Array.isArray(tasks) ? tasks : [];

  return tasks.map((task) =>
    task.n === number
      ? {
          ...task,
          done: true,
          ...(note ? { note: String(note).slice(0, NOTE_LIMIT) } : {}),
        }
      : task
  );
}

/** The task being worked on: the first one not yet ticked off. */
export function activeTask(tasks) {
  if (!Array.isArray(tasks)) return null;
  return tasks.find((task) => !task.done) || null;
}

/** @returns {{total: number, done: number, current: number|null}} */
export function taskProgress(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const active = activeTask(list);
  return {
    total: list.length,
    done: list.filter((task) => task.done).length,
    current: active ? active.n : null,
  };
}

/**
 * What the MODEL is told after it touches the list.
 *
 * Deliberately the whole list rather than an "ok": the numbering it must use
 * next was assigned here, not by it, and restating the list is what keeps the
 * two in agreement. It also re-anchors a long run on what is left to do, which
 * is exactly the thing that drifts.
 */
export function describeTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return { tasks: [], note: 'The task list is empty.' };

  const { done, total } = taskProgress(list);
  const active = activeTask(list);

  return {
    tasks: list.map((task) => `${task.n}. ${task.title}${task.done ? ' — done' : ''}`),
    progress: `${done} of ${total} done`,
    next: active ? `Task ${active.n}: ${active.title}` : 'All tasks are done. Give your answer.',
  };
}
