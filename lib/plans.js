/**
 * lib/plans.js
 * ----------------------------------------------------------------------------
 * Plans: goals broken into ordered steps, stored in Supabase.
 *
 * This is the first data Oscar OWNS rather than reads from someone else's API,
 * which changes one thing: when Supabase isn't configured, the plan tools are
 * withheld entirely (see lib/tools/index.js) rather than silently no-opping the
 * way logging does. Quietly accepting a plan and dropping it would be worse
 * than saying "I can't store plans".
 *
 * Everything here reports failure through return values or thrown Errors with
 * readable messages — those messages can end up in a notification.
 */

import { dbRequest, isConfigured } from './db.js';

export { isConfigured as isPlansConfigured };

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

export const PLAN_STATUSES = ['active', 'done', 'archived'];

/** PostgREST reserves , . : ( ) inside filter values. Strip rather than risk it. */
function safeTerm(value, max = 80) {
  return String(value || '')
    .replace(/[,.:()*%]/g, ' ')
    .trim()
    .slice(0, max);
}

function tidyStep(row) {
  return {
    step: row.step_number,
    title: row.title,
    notes: row.notes || undefined,
    done: Boolean(row.done),
  };
}

function tidyPlan(plan, steps = []) {
  const ordered = [...steps].sort((a, b) => a.step_number - b.step_number);
  const doneCount = ordered.filter((s) => s.done).length;
  const next = ordered.find((s) => !s.done);

  return {
    id: plan.id,
    title: plan.title,
    goal: plan.goal || undefined,
    status: plan.status,
    due: plan.due || undefined,
    notes: plan.notes || undefined,
    progress: ordered.length ? `${doneCount} of ${ordered.length} done` : 'no steps yet',
    // Surfaced separately because "what's next on my move plan" is the single
    // most likely question, and the model shouldn't have to scan the array.
    nextStep: next ? { step: next.step_number, title: next.title } : null,
    steps: ordered.map(tidyStep),
  };
}

/* ------------------------------------------------------------------- writes */

/**
 * @param {{title: string, goal?: string, due?: string, notes?: string, steps?: Array}} input
 */
export async function createPlan(input, deps = {}) {
  const title = String(input.title || '').trim();
  if (!title) throw new PlanError('A plan needs a title.');

  const row = {
    title: title.slice(0, 200),
    goal: input.goal ? String(input.goal).slice(0, 2000) : null,
    notes: input.notes ? String(input.notes).slice(0, 2000) : null,
    due: input.due || null,
  };

  // return=representation so we get the generated id back for the steps insert.
  const created = await dbRequest(
    'plans',
    { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row) },
    deps
  );

  if (!created.ok) throw new PlanError(`Could not save the plan: ${created.error || created.status}`);

  const plan = Array.isArray(created.data) ? created.data[0] : created.data;
  if (!plan || !plan.id) throw new PlanError('The database did not return the new plan.');

  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (steps.length) await addSteps(plan.id, steps, deps);

  return getPlan(plan.id, deps);
}

/** Append steps to the end of a plan, renumbering from wherever it left off. */
export async function addSteps(planId, steps, deps = {}) {
  const clean = (Array.isArray(steps) ? steps : [])
    .map((s) => (typeof s === 'string' ? { title: s } : s))
    .filter((s) => s && String(s.title || '').trim());

  if (!clean.length) throw new PlanError('No steps were given.');
  if (clean.length > 30) throw new PlanError('That is too many steps for one plan — keep it under 30.');

  const existing = await listSteps(planId, deps);
  let next = existing.length ? Math.max(...existing.map((s) => s.step_number)) + 1 : 1;

  const rows = clean.map((s) => ({
    plan_id: planId,
    step_number: next++,
    title: String(s.title).trim().slice(0, 300),
    notes: s.notes ? String(s.notes).slice(0, 1000) : null,
  }));

  const result = await dbRequest(
    'plan_steps',
    { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(rows) },
    deps
  );
  if (!result.ok) throw new PlanError(`Could not add the steps: ${result.error || result.status}`);

  await touchPlan(planId, deps);
  return rows.length;
}

/**
 * Mark a step done (or undone) by its step NUMBER — the thing you say out loud.
 */
export async function setStepDone(planId, stepNumber, done, deps = {}) {
  const number = Number(stepNumber);
  if (!Number.isInteger(number) || number < 1) throw new PlanError('That is not a valid step number.');

  const steps = await listSteps(planId, deps);
  const target = steps.find((s) => s.step_number === number);
  if (!target) {
    throw new PlanError(
      steps.length
        ? `That plan only has ${steps.length} step${steps.length === 1 ? '' : 's'}.`
        : 'That plan has no steps yet.'
    );
  }

  const result = await dbRequest(
    `plan_steps?id=eq.${encodeURIComponent(target.id)}`,
    {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ done: Boolean(done), done_at: done ? new Date().toISOString() : null }),
    },
    deps
  );
  if (!result.ok) throw new PlanError(`Could not update that step: ${result.error || result.status}`);

  await touchPlan(planId, deps);
  return target.title;
}

export async function updatePlan(planId, changes = {}, deps = {}) {
  const patch = {};
  if (changes.title) patch.title = String(changes.title).slice(0, 200);
  if (changes.goal !== undefined) patch.goal = changes.goal ? String(changes.goal).slice(0, 2000) : null;
  if (changes.notes !== undefined) patch.notes = changes.notes ? String(changes.notes).slice(0, 2000) : null;
  if (changes.due !== undefined) patch.due = changes.due || null;

  if (changes.status) {
    if (!PLAN_STATUSES.includes(changes.status)) {
      throw new PlanError(`Status must be one of: ${PLAN_STATUSES.join(', ')}.`);
    }
    patch.status = changes.status;
  }

  if (!Object.keys(patch).length) throw new PlanError('Nothing to change.');
  patch.updated_at = new Date().toISOString();

  const result = await dbRequest(
    `plans?id=eq.${encodeURIComponent(planId)}`,
    { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(patch) },
    deps
  );
  if (!result.ok) throw new PlanError(`Could not update the plan: ${result.error || result.status}`);
  return true;
}

export async function deletePlan(planId, deps = {}) {
  // plan_steps has ON DELETE CASCADE, so the steps go with it.
  const result = await dbRequest(
    `plans?id=eq.${encodeURIComponent(planId)}`,
    { method: 'DELETE', headers: { prefer: 'return=minimal' } },
    deps
  );
  if (!result.ok) throw new PlanError(`Could not delete the plan: ${result.error || result.status}`);
  return true;
}

/** Keep updated_at honest without needing a database trigger. */
async function touchPlan(planId, deps = {}) {
  await dbRequest(
    `plans?id=eq.${encodeURIComponent(planId)}`,
    {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ updated_at: new Date().toISOString() }),
    },
    deps
  );
}

/* -------------------------------------------------------------------- reads */

export async function listSteps(planId, deps = {}) {
  const result = await dbRequest(
    `plan_steps?plan_id=eq.${encodeURIComponent(planId)}&select=*&order=step_number.asc`,
    { method: 'GET' },
    deps
  );
  if (!result.ok) throw new PlanError(`Could not read the steps: ${result.error || result.status}`);
  return Array.isArray(result.data) ? result.data : [];
}

/**
 * Deliberately two queries rather than one PostgREST embedded select. The
 * embedding syntax works, but two plain queries are far easier to reason about
 * and to test, and each is a few tens of milliseconds.
 */
export async function getPlan(planId, deps = {}) {
  const result = await dbRequest(
    `plans?id=eq.${encodeURIComponent(planId)}&select=*&limit=1`,
    { method: 'GET' },
    deps
  );
  if (!result.ok) throw new PlanError(`Could not read the plan: ${result.error || result.status}`);

  const plan = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!plan) throw new PlanError('There is no plan with that id.');

  return tidyPlan(plan, await listSteps(plan.id, deps));
}

export async function listPlans(opts = {}, deps = {}) {
  const params = new URLSearchParams({
    select: 'id,title,goal,status,due,created_at',
    order: 'created_at.desc',
    limit: String(Math.min(Math.max(Number(opts.limit) || 20, 1), 50)),
  });

  // Default to active only — "what are my plans" means the live ones.
  if (opts.status && opts.status !== 'all') params.set('status', `eq.${opts.status}`);
  else if (!opts.status) params.set('status', 'eq.active');

  const term = safeTerm(opts.search);
  if (term) params.set('title', `ilike.*${term}*`);

  const result = await dbRequest(`plans?${params}`, { method: 'GET' }, deps);
  if (!result.ok) throw new PlanError(`Could not list plans: ${result.error || result.status}`);

  return Array.isArray(result.data) ? result.data : [];
}

/**
 * Find one plan from what a person actually said — "my move plan", "the trip".
 *
 * Exact title first, then a fuzzy contains match. If several match, we refuse
 * and name them rather than guessing: picking the wrong plan and then deleting
 * it is the failure mode worth designing against.
 */
export async function findPlan(reference, deps = {}) {
  const raw = String(reference || '').trim();
  if (!raw) throw new PlanError('Which plan did you mean?');

  // A bare number is an id.
  if (/^\d+$/.test(raw)) return getPlan(raw, deps);

  const term = safeTerm(raw);
  if (!term) throw new PlanError('Which plan did you mean?');

  // Search across every status — you may well ask about a finished plan.
  const params = new URLSearchParams({
    select: 'id,title,status',
    title: `ilike.*${term}*`,
    limit: '10',
  });
  const result = await dbRequest(`plans?${params}`, { method: 'GET' }, deps);
  if (!result.ok) throw new PlanError(`Could not search plans: ${result.error || result.status}`);

  const hits = Array.isArray(result.data) ? result.data : [];

  if (!hits.length) throw new PlanError(`I could not find a plan matching "${raw}".`);
  if (hits.length === 1) return getPlan(hits[0].id, deps);

  const exact = hits.find((p) => p.title.toLowerCase() === raw.toLowerCase());
  if (exact) return getPlan(exact.id, deps);

  throw new PlanError(
    `That matches ${hits.length} plans: ${hits.map((p) => `"${p.title}"`).join(', ')}. Which one?`
  );
}
