/**
 * lib/tools/tasks.js
 * ----------------------------------------------------------------------------
 * Google Tasks: the user's to-do list — read it, add to it, tick things off.
 *
 * "Task" here means one of THEIR to-dos, which is not what the word means in
 * lib/tasklist.js. Same word, different owner: these are saved in the user's
 * Google account and outlive the run, while Oscar's own tasks are working notes
 * that vanish with it. Prose in this file says "to-do" wherever the difference
 * could matter; the tool names keep Google's vocabulary.
 *
 * Note the API's own quirk, which shapes this file: tasks live inside task
 * *lists*, and everything needs a list id. Rather than make the model deal with
 * that, we resolve the list by name (or default to the first one) and cache it.
 */

import { googleFetch } from '../google/auth.js';

const LISTS_URL = 'https://tasks.googleapis.com/tasks/v1/users/@me/lists';
const TASKS_URL = 'https://tasks.googleapis.com/tasks/v1/lists';

/** Warm-instance cache. Task lists change about once a year. */
let listCache = null;

export function clearListCache() {
  listCache = null;
}

async function getLists(ctx) {
  if (listCache) return listCache;
  const data = await googleFetch(`${LISTS_URL}?maxResults=50`, {}, ctx);
  listCache = (data && data.items ? data.items : []).map((l) => ({ id: l.id, title: l.title }));
  return listCache;
}

/** Resolve a list by fuzzy name, falling back to the default (first) list. */
async function resolveList(name, ctx) {
  const lists = await getLists(ctx);
  if (!lists.length) throw new Error('There are no task lists on this Google account.');

  if (name) {
    const wanted = String(name).toLowerCase().trim();
    const hit =
      lists.find((l) => l.title.toLowerCase() === wanted) ||
      lists.find((l) => l.title.toLowerCase().includes(wanted));
    if (hit) return hit;
    throw new Error(`There is no task list called "${name}".`);
  }

  return lists[0];
}

function tidyTask(task, listTitle) {
  return {
    id: task.id,
    title: task.title || '(untitled)',
    notes: task.notes ? String(task.notes).slice(0, 300) : null,
    // Google Tasks due dates are date-only in practice — the time part is
    // always midnight UTC and means nothing. Trim it so the model doesn't
    // announce that something is due at 5pm when it isn't.
    due: task.due ? String(task.due).slice(0, 10) : null,
    completed: task.status === 'completed',
    list: listTitle,
  };
}

export const listTasksTool = {
  name: 'list_tasks',
  description:
    "Read the user's Google Tasks. Use for anything about their to-do list, what's due, what they " +
    'need to do, or outstanding items. Returns incomplete tasks by default, soonest due first.',
  parameters: {
    type: 'object',
    properties: {
      list: { type: 'string', description: 'Optional task list name. Defaults to the main list.' },
      includeCompleted: {
        type: 'boolean',
        description: 'Set true only if the user asks what they have already finished.',
      },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const list = await resolveList(args.list, ctx);

    const params = new URLSearchParams({
      maxResults: '50',
      showCompleted: args.includeCompleted ? 'true' : 'false',
      showHidden: 'false',
    });
    if (args.includeCompleted) params.set('showHidden', 'true');

    const data = await googleFetch(
      `${TASKS_URL}/${encodeURIComponent(list.id)}/tasks?${params}`,
      {},
      ctx
    );

    const tasks = (data && data.items ? data.items : []).map((t) => tidyTask(t, list.title));

    // Undated tasks sort last — "what's due" means dated things first.
    tasks.sort((a, b) => {
      if (a.due && b.due) return a.due < b.due ? -1 : 1;
      if (a.due) return -1;
      if (b.due) return 1;
      return 0;
    });

    return {
      list: list.title,
      count: tasks.length,
      tasks,
      note: tasks.length ? undefined : 'That list is empty.',
    };
  },
};

export const createTaskTool = {
  name: 'create_task',
  description:
    "Add a task to the user's Google Tasks. Use when they want to remember, add, or be reminded of " +
    'something without a specific meeting time. `due` is a date only, YYYY-MM-DD — Google Tasks ' +
    'does not support due times. If they gave a specific time, use create_event instead.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The task itself.' },
      notes: { type: 'string', description: 'Optional extra detail.' },
      due: { type: 'string', description: 'Optional due date as YYYY-MM-DD.' },
      list: { type: 'string', description: 'Optional task list name.' },
    },
    required: ['title'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('A task needs a title.');

    const list = await resolveList(args.list, ctx);
    const body = { title: title.slice(0, 300) };
    if (args.notes) body.notes = String(args.notes).slice(0, 2000);

    if (args.due) {
      const date = String(args.due).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('The due date must look like 2026-08-18.');
      // The API insists on a full RFC 3339 timestamp even though it only keeps
      // the date part.
      body.due = `${date}T00:00:00.000Z`;
    }

    const created = await googleFetch(
      `${TASKS_URL}/${encodeURIComponent(list.id)}/tasks`,
      { method: 'POST', body },
      ctx
    );

    return {
      created: true,
      task: tidyTask(created || body, list.title),
      confirmation: `Added "${body.title}" to ${list.title}`,
    };
  },
};

export const completeTaskTool = {
  name: 'complete_task',
  description:
    "Mark one of the user's Google Tasks to-dos as done. Call list_tasks first to find the task " +
    'id — never guess one. This only marks to-dos complete; it cannot delete them. To tick off a ' +
    'task on your own list instead, use finish_task.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The task id, from list_tasks.' },
      list: { type: 'string', description: 'The task list name, if it was not the default.' },
    },
    required: ['id'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    const list = await resolveList(args.list, ctx);

    const updated = await googleFetch(
      `${TASKS_URL}/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(args.id)}`,
      { method: 'PATCH', body: { status: 'completed' } },
      ctx
    );

    return {
      completed: true,
      task: tidyTask(updated || {}, list.title),
      confirmation: `Ticked off "${(updated && updated.title) || 'that task'}"`,
    };
  },
};

export const deleteTaskTool = {
  name: 'delete_task',
  description:
    'Delete a task permanently. Call list_tasks first to get the id — never guess one. Prefer ' +
    'complete_task when the user has finished something; only delete when they actually want it ' +
    'gone. The user is asked to confirm before anything is removed.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task id, from list_tasks.' },
      list: { type: 'string', description: 'Task list name, if not the default.' },
    },
    required: ['id'],
    additionalProperties: false,
  },

  writes: true,
  confirm: true,

  async describe(args = {}, ctx = {}) {
    const list = await resolveList(args.list, ctx);
    const task = await googleFetch(
      `${TASKS_URL}/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(args.id)}`,
      {},
      ctx
    );
    if (!task) throw new Error('That task no longer exists.');
    const due = task.due ? `, due ${String(task.due).slice(0, 10)}` : '';
    return `Delete the task "${task.title || 'untitled'}"${due} from ${list.title}?`;
  },

  async run(args = {}, ctx = {}) {
    const list = await resolveList(args.list, ctx);

    let title = 'that task';
    try {
      const task = await googleFetch(
        `${TASKS_URL}/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(args.id)}`,
        {},
        ctx
      );
      if (task && task.title) title = `"${task.title}"`;
    } catch {
      /* proceed anyway */
    }

    await googleFetch(
      `${TASKS_URL}/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(args.id)}`,
      { method: 'DELETE' },
      ctx
    );

    return { deleted: true, id: args.id, confirmation: `Deleted ${title}.` };
  },
};
