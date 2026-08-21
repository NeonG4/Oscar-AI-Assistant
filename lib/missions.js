/**
 * lib/missions.js
 * ----------------------------------------------------------------------------
 * Work that plans itself, then does itself.
 *
 *   "write me a connect 4 program"
 *      -> Oscar breaks it into steps, saves them, works through them one at a
 *         time, then notifies you and stops.
 *
 * THE PROBLEM A MISSION SOLVES THAT A JOB DOESN'T
 *
 * A job is one conversation spread across several invocations. That works until
 * the conversation itself becomes the problem: after twenty tool calls the
 * message history is enormous, every subsequent round re-sends all of it, and
 * the model's attention is spread across everything it has ever done rather
 * than the thing in front of it. Cost climbs, quality falls.
 *
 * So a mission does NOT keep one long conversation. It keeps a TASK LIST, and
 * runs a SEPARATE, SHORT conversation for each step on it.
 *
 *   the task list — the durable memory. Which steps exist, which are done.
 *   the notes     — one line per finished step, carried forward.
 *   the agent     — thrown away and rebuilt between steps.
 *
 * WHOSE LIST THIS IS
 *
 * A mission's task list is Oscar's own breakdown of the goal, not something the
 * user asked to have saved — see lib/tasklist.js for the three-way split
 * between a task, a plan and a to-do. One wrinkle worth knowing before reading
 * further: this list is currently PERSISTED as a row in the user's plans table,
 * because create_plan is what writes it and `planId` is what points at it. So
 * the two do share storage today, even though they are different things. The
 * prose below calls it a task list and keeps "plan" for the row itself.
 *
 * That last line is the important one. Each task starts with a fresh context
 * containing only the goal, the plan, the notes so far, and the single step it
 * is meant to do. Step 8 costs the same as step 1, and a mission of thirty
 * steps is as affordable as a mission of three.
 *
 * THREE PHASES
 *
 *   planning  — one agent run whose only job is to produce the task list
 *   working   — one agent run per step, in order
 *   wrapping  — one final run to summarise what happened
 *
 * Each returns the same {state, status} shape as runAgentStep, so api/step.js
 * drives a mission with exactly the same loop it uses for anything else.
 */

import {
  createAgentState,
  runAgentStep,
  resumeWithAnswer,
  isAwaitingAnswer,
  sanitizeHistory,
} from './agent.js';
import { getPlan, setStepDone, updatePlan } from './plans.js';

/**
 * A mission may take this many agent rounds in total.
 *
 * Much higher than a job's ceiling because the whole point is work that keeps
 * going, but still finite: a mission that has burned 300 rounds is stuck, not
 * thorough, and the kindest thing to do is stop and say so.
 */
export const MAX_MISSION_STEPS = 300;

/** Rounds one single task may take before the mission moves on without it. */
const MAX_ROUNDS_PER_TASK = 14;

/** Notes are the carried memory, so they are kept short on purpose. */
const NOTE_LIMIT = 400;
const MAX_NOTES_CARRIED = 20;

export class MissionError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'MissionError';
    this.status = status;
  }
}

/* --------------------------------------------------------------------- state */

/**
 * The serialisable state of a whole mission. Lives in `jobs.state`.
 *
 * Note what is NOT here: a growing message history. `agent` holds only the
 * current task's conversation and is nulled between tasks.
 */
export function createMissionState(input, env = process.env) {
  const goal = String(input.question || '').trim();
  if (!goal) throw new MissionError('A mission needs a goal.', 400);

  return {
    kind: 'mission',
    phase: 'planning',
    goal,
    planId: null,
    notes: [],
    tasksDone: 0,
    round: 0,
    // Carried so each sub-run is built with the same authority and settings as
    // the request that started the mission.
    canWrite: input.canWrite === true,
    model: input.model || env.OSCAR_DEEP_MODEL || env.OPENAI_MODEL || 'gpt-4o',
    timeZone: input.timeZone || env.OSCAR_TIMEZONE || 'UTC',
    coords: input.coords || null,
    ip: input.ip || null,
    // A mission is autonomous by definition — there is nobody watching to
    // answer a confirmation prompt mid-run, so destructive tools must not stop
    // to ask. They are still gated by canWrite; this only decides whether a
    // permitted action pauses for a human who isn't there.
    requireConfirm: false,
    // Carried for the PLANNING run only. "Now build that as a script" is a
    // perfectly ordinary way to start a mission, and the thing being referred to
    // is in the conversation rather than in the sentence. Later steps work from
    // the plan and the notes, which by then say everything that matters.
    history: sanitizeHistory(input.history),
    agent: null,
    events: [],
    // Mirrors the stored steps, so the web app can render a mission's progress
    // with exactly the same task list it renders for an ordinary run. Filled in
    // once the row exists; see the working phase below.
    tasks: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    toolsUsed: [],
  };
}

export function isMissionState(state) {
  return Boolean(state && state.kind === 'mission');
}

/**
 * Hand an answer back to the task that asked for it.
 *
 * A mission's own state has nothing to unfreeze — the parked round lives in the
 * sub-agent, so this simply passes the answer down and leaves everything else
 * exactly as it was. The mission then carries on from the same phase and the
 * same step, which is the point.
 */
export function resumeMissionWithAnswer(state, answer) {
  if (!isAwaitingAnswer(state && state.agent)) {
    throw new MissionError('That mission is not waiting on a question.', 409);
  }
  return { ...state, agent: resumeWithAnswer(state.agent, answer) };
}

/** @returns {boolean} is this mission parked on an unanswered question? */
export function isMissionAwaitingAnswer(state) {
  return isMissionState(state) && isAwaitingAnswer(state.agent);
}

/* -------------------------------------------------------------------- prompts */

function planningPrompt(goal) {
  return [
    `Your goal: ${goal}`,
    '',
    'Do not attempt the goal yet. Your only job right now is to break it into',
    'the steps you are then going to work through.',
    '',
    'Call create_plan exactly once, with:',
    '  - a short title naming the goal',
    '  - 3 to 8 steps, in an order where each one unblocks the next',
    '  - each step one concrete action you could actually carry out',
    '',
    'This list is your own task list for the work ahead, not a plan the user has',
    'asked you to keep, so write the steps for YOURSELF to do rather than as',
    'instructions for them. If the goal needs files written or commands run, say',
    'so in the step. Do not pad it with steps like "review the results".',
    '',
    'After create_plan returns, reply with one short sentence naming the list.',
  ].join('\n');
}

function taskPrompt({ goal, plan, step, notes }) {
  const done = plan.steps.filter((s) => s.done);
  const lines = [
    `You are working towards this goal: ${goal}`,
    '',
    `Your task list is "${plan.title}" and has ${plan.steps.length} steps.`,
  ];

  if (done.length) {
    lines.push('', 'Already finished:');
    for (const s of done) lines.push(`  ${s.step}. ${s.title}`);
  }

  if (notes.length) {
    lines.push('', 'What happened so far:');
    for (const note of notes.slice(-MAX_NOTES_CARRIED)) lines.push(`  - ${note}`);
  }

  lines.push(
    '',
    `YOUR TASK NOW is step ${step.step} only: ${step.title}`,
    step.notes ? `Detail: ${step.notes}` : '',
    '',
    'Do that one step and nothing further down the list. Use your tools to',
    'actually carry it out rather than describing how it would be done.',
    '',
    'When the step is finished, reply with one or two sentences saying what you',
    'did and anything the later steps need to know — a filename, a decision you',
    'made, a value you found. That sentence is the only thing carried forward,',
    'so put what matters in it.',
    '',
    'If the step turns out to be impossible, say so plainly and explain why.',
    'Do not call plan_tasks, create_plan or complete_plan_step. The task list you',
    'are working through was drawn up at the start of this mission and is ticked',
    'off for you as you go — it needs nothing from you but the work itself.'
  );

  return lines.filter(Boolean).join('\n');
}

function wrapUpPrompt({ goal, plan, notes }) {
  return [
    `The goal was: ${goal}`,
    '',
    `You have finished all ${plan.steps.length} steps of "${plan.title}".`,
    '',
    'What happened, step by step:',
    ...notes.map((note, i) => `  ${i + 1}. ${note}`),
    '',
    'Tell the user what you produced, in two or three sentences. Lead with the',
    'thing itself — where the file is, what it does, how to run it. Do not',
    'recap the process or list the steps back to them.',
  ].join('\n');
}

/* --------------------------------------------------------------------- helpers */

/**
 * Build the short-lived agent for one phase of the mission.
 *
 * `tools: false` is passed rather than switched off afterwards, so the system
 * prompt is built to match. Telling a model it has tools and then offering it
 * none is a small inconsistency that shows up as the model narrating a tool
 * call it never made.
 */
function subAgent(state, question, env, { tools = true, history } = {}) {
  return createAgentState(
    {
      question,
      history,
      tools,
      canWrite: state.canWrite,
      model: state.model,
      timeZone: state.timeZone,
      coords: state.coords,
      ip: state.ip,
      requireConfirm: state.requireConfirm,
    },
    env
  );
}

/** Roll a finished sub-run's spending and trace up into the mission. */
function absorb(state, agent) {
  const usage = agent.usage || {};
  return {
    ...state,
    usage: {
      prompt_tokens: state.usage.prompt_tokens + (usage.prompt_tokens || 0),
      completion_tokens: state.usage.completion_tokens + (usage.completion_tokens || 0),
      total_tokens: state.usage.total_tokens + (usage.total_tokens || 0),
    },
    toolsUsed: [...state.toolsUsed, ...(agent.toolsUsed || [])],
    events: [...state.events, ...(agent.events || [])],
  };
}

function done(state, { title, answer, detail }) {
  return {
    title: title || 'Mission complete',
    answer,
    detail: detail || '',
    model: state.model,
    usage: state.usage.total_tokens ? state.usage : null,
    toolsUsed: state.toolsUsed,
    rounds: state.round,
    events: state.events,
    tasks: state.tasks || [],
  };
}

/* ------------------------------------------------------------------ the loop */

/**
 * Advance a mission by one agent round.
 *
 * Same contract as runAgentStep: one round of work, then hand control back so
 * the caller decides whether there is budget for another.
 *
 * @returns {Promise<{state: object, status: 'working'|'done', result?: object}>}
 */
export async function runMissionStep(state, deps = {}) {
  const env = deps.env || process.env;
  const next = { ...state, round: state.round + 1 };

  if (next.round > MAX_MISSION_STEPS) {
    return {
      state: next,
      status: 'done',
      result: done(next, {
        title: 'Stopped',
        answer: `I stopped after ${MAX_MISSION_STEPS} rounds without finishing. ${
          next.tasksDone ? `${next.tasksDone} steps were completed.` : ''
        }`.trim(),
      }),
    };
  }

  /* ---- planning ---------------------------------------------------------- */
  if (next.phase === 'planning') {
    if (!next.agent) {
      next.agent = subAgent(next, planningPrompt(next.goal), env, { history: next.history });
    }

    const step = await runAgentStep(next.agent, deps);
    next.agent = step.state;

    if (step.status === 'working') return { state: next, status: 'working' };

    // Asking before it has even planned is legitimate — a goal ambiguous
    // enough to be unplannable is exactly when asking is worth the wait.
    if (step.status === 'question') {
      return { state: next, status: 'question', result: step.result };
    }

    // The plan is found by looking at what the tool actually created rather
    // than by parsing the model's prose, which would be a guess.
    const created = (step.state.events || []).find(
      (e) => e.tool === 'create_plan' && e.ok !== false && e.ref
    );
    const planId = created && created.ref;

    const merged = absorb(next, step.state);
    merged.agent = null;

    if (!planId) {
      // No plan means nothing to work through. Rather than looping, fall back
      // to whatever the run did produce — usually a direct answer, which for a
      // goal that turned out to be simple is the right outcome anyway.
      return {
        state: merged,
        status: 'done',
        result: done(merged, {
          title: (step.result && step.result.title) || 'Done',
          answer:
            (step.result && step.result.answer) ||
            'I could not break that into steps, so there is nothing to work through.',
        }),
      };
    }

    merged.planId = planId;
    merged.phase = 'working';
    return { state: merged, status: 'working' };
  }

  /* ---- working ----------------------------------------------------------- */
  if (next.phase === 'working') {
    const plan = await getPlan(next.planId, { ...deps, env });
    const step = plan.steps.find((s) => !s.done);

    // The stored row IS this mission's task list, so it is copied across on
    // every pass rather than tracked separately — the row is the truth about
    // which steps are done, and duplicating that bookkeeping would only create
    // a second version of it to disagree with.
    next.tasks = plan.steps.map((s) => ({
      n: s.step,
      title: s.title,
      done: Boolean(s.done),
      ...(s.notes ? { note: String(s.notes).slice(0, 200) } : {}),
    }));

    if (!step) {
      next.phase = 'wrapping';
      next.agent = null;
      return { state: next, status: 'working' };
    }

    if (!next.agent) {
      next.agent = subAgent(next, taskPrompt({ goal: next.goal, plan, step, notes: next.notes }), env);
      next.agent.missionStep = step.step;
    }

    const turn = await runAgentStep(next.agent, deps);
    next.agent = { ...turn.state, missionStep: step.step };

    // ---- the task stopped to ask something ---------------------------------
    // The whole mission parks, not just this task. There is nobody watching a
    // mission, so carrying on with the other steps while a question hangs would
    // mean building on top of a decision that has not been made yet.
    //
    // Note this is unaffected by requireConfirm being false: a mission does not
    // stop to confirm an action it is allowed to take, but it absolutely stops
    // when it does not know something.
    if (turn.status === 'question') {
      return { state: next, status: 'question', result: turn.result };
    }

    // A task that will not converge must not hold the whole mission hostage.
    // Mark it done with an honest note and move on — later steps can often
    // still succeed, and the summary will say what was skipped.
    const stuck = turn.status === 'working' && next.agent.round >= MAX_ROUNDS_PER_TASK;

    if (turn.status === 'working' && !stuck) return { state: next, status: 'working' };

    const note = stuck
      ? `Step ${step.step} (${step.title}) did not finish — I gave up on it after ${MAX_ROUNDS_PER_TASK} rounds.`
      : `Step ${step.step} (${step.title}): ${String(
          (turn.result && turn.result.answer) || 'done'
        ).slice(0, NOTE_LIMIT)}`;

    await setStepDone(next.planId, step.step, true, { ...deps, env }).catch(() => {});

    const merged = absorb(next, next.agent);
    merged.agent = null;
    merged.notes = [...merged.notes, note];
    merged.tasksDone = merged.tasksDone + 1;

    return { state: merged, status: 'working' };
  }

  /* ---- wrapping ---------------------------------------------------------- */
  const plan = await getPlan(next.planId, { ...deps, env }).catch(() => null);

  if (!next.agent) {
    next.agent = subAgent(
      next,
      wrapUpPrompt({
        goal: next.goal,
        plan: plan || { title: 'the plan', steps: [] },
        notes: next.notes,
      }),
      env,
      // The summary needs no tools — everything it describes already happened.
      // Withholding them stops a wrap-up wandering back into doing work.
      { tools: false }
    );
  }

  const turn = await runAgentStep(next.agent, deps);
  next.agent = turn.state;

  if (turn.status === 'working') return { state: next, status: 'working' };

  const merged = absorb(next, next.agent);
  merged.agent = null;

  // The task list is finished, so the row holding it should stop showing up as
  // active work alongside the user's own plans.
  if (merged.planId) {
    await updatePlan(merged.planId, { status: 'done' }, { ...deps, env }).catch(() => {});
  }

  return {
    state: merged,
    status: 'done',
    result: done(merged, {
      title: (turn.result && turn.result.title) || 'Done',
      answer: (turn.result && turn.result.answer) || 'Finished.',
      detail: (turn.result && turn.result.detail) || '',
    }),
  };
}
