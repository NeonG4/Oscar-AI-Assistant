/**
 * lib/tools/checklist.js
 * ----------------------------------------------------------------------------
 * The two tools Oscar uses to show his working: plan_tasks and finish_task.
 *
 * THE LIST THESE EDIT IS OSCAR'S OWN — see lib/tasklist.js for the three-way
 * split. A task is his and dies with the run; a plan and a to-do are the
 * user's and outlive it. Nothing in this file touches either of those.
 *
 * These are unusual in that they change nothing outside the run. They take no
 * database, no Google account and no write permission — calling plan_tasks does
 * not create anything you could look at tomorrow. What they do is make the
 * shape of the work visible WHILE it happens, which is the difference between
 * a spinner and a progress bar.
 *
 * WHY THE RESULT IS NOT THE STATE
 *
 * A tool cannot reach into the agent's state — tools are pure functions handed
 * arguments and a context. So these return an intent (`taskList`, `taskDone`),
 * lib/tools/index.js lifts it out the way it already lifts a question or a
 * confirmation, and lib/agent.js folds it into the run's state. The tool stays
 * dumb, the state stays in one place, and the numbering the model must use next
 * is assigned by lib/tasklist.js rather than guessed by the model.
 */

import { normalizeTasks, MAX_TASKS } from '../tasklist.js';

export const planTasksTool = {
  name: 'plan_tasks',
  description:
    'Break the request into an ordered list of tasks, before you start on it. Call this FIRST ' +
    'for anything that takes more than one step — research with several parts, anything you ' +
    'have to look up before you can act on it, anything you are building or drafting, anything ' +
    'where you would otherwise say "first... then...". ' +
    `Give 2 to ${MAX_TASKS} tasks, each one concrete thing YOU will do, in an order where each ` +
    'unblocks the next. The user sees this list appear and watches you work through it, so ' +
    'write it for them to read: short, specific, no filler steps like "review the results". ' +
    'Do not call this for a single lookup or something you can simply answer — a task list for ' +
    'a one-step question is noise. Call it once per run, at the start. ' +
    "This list is your own working note for this run: it is not the user's to-do list and not " +
    'one of their saved plans, and none of it is kept once the run ends.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'The tasks, in the order you will do them. One short line each.',
        items: { type: 'string' },
      },
    },
    required: ['tasks'],
    additionalProperties: false,
  },

  /** Tells lib/tools/index.js that this tool's result edits the task list. */
  tracks: true,

  run(args = {}) {
    const tasks = normalizeTasks(args.tasks);
    if (tasks.length < 2) {
      return {
        error:
          'A task list needs at least two tasks. If the request is a single step, just do it ' +
          'instead of planning it.',
      };
    }
    return { taskList: tasks };
  },
};

export const finishTaskTool = {
  name: 'finish_task',
  description:
    'Mark one task from your own list as done, and say what came of it. Call this the moment a ' +
    'task is actually finished — not in a batch at the end, because the point is that the user ' +
    'can see where you are while you are still working. The note is one line: what you found, ' +
    'what you made, what you decided. If a task turned out to be impossible, still mark it done ' +
    "and say so in the note. This ticks off YOUR list only — to tick off one of the user's " +
    'to-dos use complete_task, and for a step of a plan they have saved use complete_plan_step.',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'integer',
        description: 'The task number, as given back to you by plan_tasks.',
      },
      note: {
        type: 'string',
        description: 'One line on the outcome. What you found, made, or could not do.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },

  tracks: true,

  run(args = {}) {
    const n = Number(args.task);
    if (!Number.isFinite(n) || n < 1) {
      return { error: 'Give the task number from your list, e.g. 2.' };
    }
    return { taskDone: n, note: args.note ? String(args.note) : undefined };
  },
};
