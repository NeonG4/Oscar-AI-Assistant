/**
 * lib/tools/plans.js
 * ----------------------------------------------------------------------------
 * Plan tools: break a goal into steps, keep them, tick them off.
 *
 * A plan is the USER'S — theirs to keep, theirs to tick off weeks later. It is
 * not the list Oscar makes to show his working on one run: that is a task list,
 * it lives in the run's own state, and it is made with plan_tasks
 * (lib/tools/checklist.js). See lib/tasklist.js for the full split.
 *
 *   "plan my move to Seattle next month"
 *      → Oscar drafts the steps and saves them
 *   "what's next on my move plan?"
 *      → the first unfinished step
 *   "mark step 2 done"
 *      → ticked
 *
 * TWO THINGS THAT SHAPE THIS FILE
 *
 *   1. Plans are referred to by NAME, not id. Nobody says "plan 7". Every tool
 *      takes a `plan` string and resolves it fuzzily — and if it's ambiguous,
 *      refuses and names the candidates rather than guessing. Guessing wrong
 *      and then deleting is the failure worth designing against.
 *
 *   2. Steps are addressed by their NUMBER, not their row id. "Mark step 2
 *      done" should work without a lookup round trip, so step_number is what
 *      the model passes.
 */

import {
  createPlan,
  findPlan,
  listPlans,
  addSteps,
  setStepDone,
  updatePlan,
  deletePlan,
  PLAN_STATUSES,
} from '../plans.js';

export const createPlanTool = {
  name: 'create_plan',
  description:
    'Create a plan: a goal broken into ordered steps, saved for later. Use when the user wants to ' +
    'plan, organise, or work out how to do something multi-step. YOU write the steps — break the ' +
    'goal into 3 to 8 concrete actions, each one thing the user could actually sit down and do. ' +
    'Order them so earlier steps unblock later ones. Do not pad with filler like "review progress". ' +
    'For a single reminder use create_task instead; a plan is for something with stages. ' +
    'A plan belongs to the user and outlives the conversation, so never create one to organise ' +
    'your own work — plan_tasks does that.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short name, e.g. "Move to Seattle". How the user will refer to it.' },
      goal: { type: 'string', description: 'One sentence on what success looks like.' },
      steps: {
        type: 'array',
        description: 'The steps, in order. 3-8 is the useful range.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'One concrete action.' },
            notes: { type: 'string', description: 'Optional detail.' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      due: { type: 'string', description: 'Optional target date, YYYY-MM-DD.' },
    },
    required: ['title', 'steps'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    if (args.due && !/^\d{4}-\d{2}-\d{2}$/.test(String(args.due))) {
      throw new Error('The due date must look like 2026-09-01.');
    }

    const plan = await createPlan(args, ctx);
    return {
      created: true,
      plan,
      confirmation: `Saved "${plan.title}" with ${plan.steps.length} steps. First up: ${
        plan.nextStep ? plan.nextStep.title : 'nothing yet'
      }.`,
    };
  },
};

export const listPlansTool = {
  name: 'list_plans',
  description:
    'List the user\'s saved plans. Use for "what plans do I have", "what am I working on". Returns ' +
    'active plans by default. Titles and goals only — call get_plan for the steps of one.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...PLAN_STATUSES, 'all'],
        description: 'Defaults to active.',
      },
      search: { type: 'string', description: 'Optional words to match against plan titles.' },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const plans = await listPlans(args, ctx);
    return {
      count: plans.length,
      plans: plans.map((p) => ({ title: p.title, goal: p.goal || undefined, status: p.status, due: p.due || undefined })),
      note: plans.length ? undefined : 'No plans saved yet.',
    };
  },
};

export const getPlanTool = {
  name: 'get_plan',
  description:
    'Read one plan in full: every step, which are done, and what comes next. Use for "what\'s next ' +
    'on my move plan", "how far through am I". Refer to the plan by name as the user said it — ' +
    'partial names work.',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The plan name, as the user said it. Partial is fine.' },
    },
    required: ['plan'],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    return findPlan(args.plan, ctx);
  },
};

export const addPlanStepsTool = {
  name: 'add_plan_steps',
  description:
    'Append steps to an existing plan. They go on the end and are numbered automatically. Use when ' +
    'the user thinks of something else that needs doing. To change an existing step, there is no ' +
    'edit tool — add a new one or start over.',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The plan name.' },
      steps: {
        type: 'array',
        description: 'Steps to append, in order.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
    },
    required: ['plan', 'steps'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    const plan = await findPlan(args.plan, ctx);
    const added = await addSteps(plan.id, args.steps, ctx);
    return {
      added,
      plan: await findPlan(String(plan.id), ctx),
      confirmation: `Added ${added} step${added === 1 ? '' : 's'} to "${plan.title}".`,
    };
  },
};

export const completePlanStepTool = {
  name: 'complete_plan_step',
  description:
    'Tick a step off a plan, by its step number — "mark step 2 done". Set done to false to undo it. ' +
    'If the user says which step by description rather than number, call get_plan first to find the ' +
    'number; never guess.',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The plan name.' },
      step: { type: 'integer', minimum: 1, description: 'Step number, as shown by get_plan.' },
      done: { type: 'boolean', description: 'Defaults to true. False un-ticks it.' },
    },
    required: ['plan', 'step'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    const plan = await findPlan(args.plan, ctx);
    const done = args.done !== false;
    const stepTitle = await setStepDone(plan.id, args.step, done, ctx);
    const updated = await findPlan(String(plan.id), ctx);

    return {
      updated: true,
      plan: updated,
      confirmation: done
        ? `Ticked off "${stepTitle}". ${
            updated.nextStep ? `Next: ${updated.nextStep.title}.` : 'That was the last one.'
          }`
        : `Marked "${stepTitle}" as not done.`,
    };
  },
};

export const updatePlanTool = {
  name: 'update_plan',
  description:
    'Change a plan\'s title, goal, due date or status. Set status to "done" when the user has ' +
    'finished it, or "archived" to put it away without deleting. This does not touch the steps.',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The plan name.' },
      title: { type: 'string', description: 'New title.' },
      goal: { type: 'string', description: 'New goal.' },
      due: { type: 'string', description: 'New target date, YYYY-MM-DD.' },
      status: { type: 'string', enum: PLAN_STATUSES, description: 'New status.' },
    },
    required: ['plan'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    const plan = await findPlan(args.plan, ctx);
    const { plan: _ignored, ...changes } = args;
    await updatePlan(plan.id, changes, ctx);
    return {
      updated: true,
      plan: await findPlan(String(plan.id), ctx),
      confirmation: `Updated "${plan.title}".`,
    };
  },
};

export const deletePlanTool = {
  name: 'delete_plan',
  description:
    'Delete a plan and all of its steps. The user is asked to confirm before anything is removed. ' +
    'If they have merely finished the plan, prefer update_plan with status "done" — that keeps it.',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The plan name.' },
    },
    required: ['plan'],
    additionalProperties: false,
  },

  writes: true,
  confirm: true,

  /** Read-only, and names what will be destroyed including how much work is in it. */
  async describe(args = {}, ctx = {}) {
    const plan = await findPlan(args.plan, ctx);
    const count = plan.steps.length;
    return `Delete the plan "${plan.title}" and its ${count} step${count === 1 ? '' : 's'}? This cannot be undone.`;
  },

  async run(args = {}, ctx = {}) {
    const plan = await findPlan(args.plan, ctx);
    await deletePlan(plan.id, ctx);
    return { deleted: true, confirmation: `Deleted the plan "${plan.title}".` };
  },
};
