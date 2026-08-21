/**
 * lib/people.js
 * ----------------------------------------------------------------------------
 * The people you know, stored in Supabase.
 *
 * Like plans, this is data Oscar OWNS rather than reads from someone else's
 * API, so the same rule applies: with no database configured the tools are
 * withheld entirely (see lib/tools/index.js) rather than accepting a name and
 * quietly dropping it.
 *
 * WHAT MAKES THIS TABLE DIFFERENT FROM EVERY OTHER ONE
 *
 * Most of what ends up here was never explicitly given. You say "I'm writing to
 * my sister Olivia" because you want help writing to her; remembering that
 * Olivia is your sister is a side effect. lib/catch.js is the part that listens
 * for that, and it is off by default. This file is the storage underneath, and
 * it is used identically whether a fact arrived because you asked for it to be
 * saved or because Oscar noticed it.
 *
 * THE ONE RULE THAT MATTERS: A PASSIVE FACT MAY FILL A GAP, NEVER OVERWRITE ONE
 *
 * mergePerson() takes an `overwrite` flag. Explicit saves get it; background
 * ones do not. So if you have told Oscar that Olivia works at Acme, nothing he
 * infers from a passing sentence can quietly replace that — the worst a bad
 * inference can do is add a note or an extra email, both of which you can see
 * and remove. Getting this backwards would mean a misheard sentence silently
 * rewriting your address book, which is the failure mode worth designing
 * against here.
 *
 * ONE ROW PER NAME. `name` is what you call them, and the database has a unique
 * index on lower(name) so "add this to Olivia" merges rather than making a
 * second Olivia. See db/schema.sql for why that is enforced there and not here.
 */

import { dbRequest, isConfigured } from './db.js';

export { isConfigured as isPeopleConfigured };

export class PersonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersonError';
  }
}

/** Where a row came from. 'explicit' outranks 'background' and never decays. */
export const PERSON_SOURCES = ['explicit', 'background'];

/** Per-person caps. Not database constraints — just a refusal to grow forever. */
export const MAX_EMAILS = 6;
export const MAX_PHONES = 6;
export const MAX_NOTES = 20;

/** The scalar columns, in the order they are worth reading. */
const FIELDS = ['full_name', 'relationship', 'birthday', 'company', 'role', 'location'];

/** PostgREST reserves , . : ( ) inside filter values. Strip rather than risk it. */
function safeTerm(value, max = 80) {
  return String(value || '')
    .replace(/[,.:()*%]/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * What you call them, tidied.
 *
 * Speech-to-text hands over trailing commas and stray full stops — "my sister,
 * Olivia," — and a name with punctuation welded on would never match itself
 * again on the way back out.
 */
export function cleanName(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:'"-]+|[\s,.;:'"-]+$/g, '')
    .slice(0, 80)
    .trim();
}

function cleanScalar(value, max = 200) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/** A deliberately loose check: the point is to reject prose, not to police TLDs. */
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanEmails(values) {
  return dedupe(
    (Array.isArray(values) ? values : [values])
      .map((v) => String(v == null ? '' : v).trim().toLowerCase())
      .filter(looksLikeEmail),
    (v) => v
  ).slice(0, MAX_EMAILS);
}

/**
 * Phone numbers are kept exactly as they were said.
 *
 * De-duplication compares digits only — "(206) 555 0142" and "2065550142" are
 * the same number — but the stored form is the readable one, because a number
 * you have to reformat before dialling is a number you will not use.
 */
function cleanPhones(values) {
  return dedupe(
    (Array.isArray(values) ? values : [values])
      .map((v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 40))
      .filter((v) => (v.match(/\d/g) || []).length >= 6),
    (v) => v.replace(/\D/g, '')
  ).slice(0, MAX_PHONES);
}

function cleanNotes(values) {
  return dedupe(
    (Array.isArray(values) ? values : [values])
      .map((v) => cleanScalar(v, 200))
      .filter(Boolean),
    (v) => v.toLowerCase()
  );
}

/**
 * Are these two lists the same, in the same order?
 *
 * Compared by content rather than by length, which is not pedantry: once a list
 * is at its cap, adding to it produces a list of exactly the same length, and a
 * length check would decide nothing had changed and drop the new value on the
 * floor.
 */
function sameList(next, previous) {
  const before = previous || [];
  return next.length === before.length && next.every((value, i) => value === before[i]);
}

/** Keep the first occurrence of each key, preserving order. */
function dedupe(list, keyOf) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Everything a caller may set, cleaned. Unknown keys are dropped on the floor. */
export function normalizePerson(input = {}) {
  const person = { name: cleanName(input.name) };

  for (const field of FIELDS) {
    // Accept both the column name and the camelCase a tool schema would use.
    const camel = field.replace(/_(.)/g, (_, c) => c.toUpperCase());
    const value = input[field] !== undefined ? input[field] : input[camel];
    const cleaned = cleanScalar(value, field === 'relationship' ? 120 : 200);
    if (cleaned) person[field] = cleaned;
  }

  const emails = cleanEmails(input.emails ?? input.email ?? []);
  const phones = cleanPhones(input.phones ?? input.phone ?? []);
  const notes = cleanNotes(input.notes ?? input.note ?? []);

  if (emails.length) person.emails = emails;
  if (phones.length) person.phones = phones;
  if (notes.length) person.notes = notes;

  return person;
}

/** The shape the model and the API see. Arrays stay arrays; nulls disappear. */
export function tidyPerson(row) {
  if (!row) return null;
  const out = { id: row.id, name: row.name };

  for (const field of FIELDS) {
    if (row[field]) out[field.replace(/_(.)/g, (_, c) => c.toUpperCase())] = row[field];
  }

  if (row.emails && row.emails.length) out.emails = row.emails;
  if (row.phones && row.phones.length) out.phones = row.phones;
  if (row.notes && row.notes.length) out.notes = row.notes;

  // Surfaced on every read, deliberately. "Where did you get that?" should be
  // answerable without a second lookup, and a fact Oscar inferred deserves to
  // be labelled as inferred every time it is repeated back.
  out.source = row.source || 'explicit';
  out.mentions = row.mentions || 1;
  if (row.last_seen_at) out.lastMentioned = row.last_seen_at;

  return out;
}

/* ------------------------------------------------------------------- merge */

/**
 * Fold new information into a person that already exists.
 *
 * Pure, and exported for that reason: this is where the rules about what
 * background catching may and may not do actually live, so it is the thing
 * worth testing directly rather than through a fake database.
 *
 * @param {object} existing   the row as stored
 * @param {object} incoming   already through normalizePerson()
 * @param {{overwrite?: boolean, source?: string}} [opts]
 *        overwrite  true when the user said it themselves. A scalar already on
 *                   file is replaced only then; otherwise new values may fill
 *                   an empty field but never contradict a full one.
 * @returns {object|null} the columns to write, or null when nothing changed
 */
export function mergePerson(existing = {}, incoming = {}, opts = {}) {
  const overwrite = opts.overwrite === true;
  const patch = {};

  for (const field of FIELDS) {
    const value = incoming[field];
    if (!value) continue;
    const current = existing[field];
    if (current && !overwrite) continue;
    if (current && String(current).trim() === String(value).trim()) continue;
    patch[field] = value;
  }

  // Arrays are always a union, at every trust level. Learning a second address
  // is new information; it is never a correction of the first one.
  for (const [field, clean, cap] of [
    ['emails', cleanEmails, MAX_EMAILS],
    ['phones', cleanPhones, MAX_PHONES],
  ]) {
    const added = incoming[field] || [];
    if (!added.length) continue;
    const merged = clean([...(existing[field] || []), ...added]).slice(0, cap);
    if (!sameList(merged, existing[field])) patch[field] = merged;
  }

  if (incoming.notes && incoming.notes.length) {
    const merged = cleanNotes([...(existing.notes || []), ...incoming.notes]);
    // Oldest notes fall off the end rather than the newest being refused. What
    // someone is doing now is worth more than what they were doing a year ago.
    const capped = merged.slice(-MAX_NOTES);
    if (!sameList(capped, existing.notes)) patch.notes = capped;
  }

  // A fuller name is an upgrade, not a rename: "Olivia" stays the handle you
  // say, and "Olivia Stall" goes in full_name where it belongs.
  if (incoming.name && !existing.full_name && !patch.full_name) {
    const longer = incoming.name.length > String(existing.name || '').length;
    const contains = incoming.name.toLowerCase().includes(String(existing.name || '').toLowerCase());
    if (longer && contains) patch.full_name = incoming.name;
  }

  // Confirming in your own words promotes a row Oscar had only inferred. It
  // never travels the other way: once you have said it, it is yours.
  if (overwrite && existing.source === 'background') patch.source = 'explicit';

  // Always present, which is why this function returns a patch rather than
  // "nothing changed": a mention is worth recording even when it taught us
  // nothing new, and it is what keeps "who am I actually talking about lately"
  // answerable. Callers wanting the interesting keys filter these three out.
  patch.mentions = (Number(existing.mentions) || 0) + 1;
  patch.last_seen_at = new Date().toISOString();
  patch.updated_at = patch.last_seen_at;

  return patch;
}

/** The keys mergePerson always writes, which are never news in themselves. */
export const BOOKKEEPING_KEYS = ['mentions', 'last_seen_at', 'updated_at', 'source'];

/* ------------------------------------------------------------------ writes */

/**
 * Save a person, merging into whoever is already under that name.
 *
 * One round trip to look them up and one to write, rather than a PostgREST
 * upsert, because merging is not the same as replacing: the existing row has to
 * be READ before the rules in mergePerson() can be applied to it.
 *
 * @param {object} input                 name, plus anything else known
 * @param {{overwrite?: boolean, source?: 'explicit'|'background'}} [opts]
 * @returns {Promise<{person: object, created: boolean, changed: string[]}>}
 */
export async function rememberPerson(input, opts = {}, deps = {}) {
  const incoming = normalizePerson(input);
  if (!incoming.name) throw new PersonError('A person needs a name.');

  const source = PERSON_SOURCES.includes(opts.source) ? opts.source : 'explicit';
  const overwrite = opts.overwrite !== undefined ? opts.overwrite === true : source === 'explicit';

  const existing = await lookupByName(incoming.name, deps);

  if (!existing) {
    const row = {
      ...incoming,
      emails: incoming.emails || [],
      phones: incoming.phones || [],
      notes: incoming.notes || [],
      source,
      mentions: 1,
      last_seen_at: new Date().toISOString(),
    };

    const created = await dbRequest(
      'people',
      { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row) },
      deps
    );

    // A duplicate key here means two mentions of the same person raced each
    // other — which is exactly what the unique index is for. The right response
    // is to merge into whoever won, not to fail.
    if (!created.ok) {
      if (isDuplicate(created)) return rememberPerson(input, opts, deps);
      throw new PersonError(`Could not save that person: ${created.error || created.status}`);
    }

    const saved = Array.isArray(created.data) ? created.data[0] : created.data;
    return { person: tidyPerson(saved), created: true, changed: Object.keys(incoming) };
  }

  const patch = mergePerson(existing, incoming, { overwrite });
  const changed = Object.keys(patch).filter((key) => !BOOKKEEPING_KEYS.includes(key));

  const updated = await dbRequest(
    `people?id=eq.${encodeURIComponent(existing.id)}`,
    { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(patch) },
    deps
  );
  if (!updated.ok) {
    throw new PersonError(`Could not update that person: ${updated.error || updated.status}`);
  }

  const saved = Array.isArray(updated.data) ? updated.data[0] : updated.data;
  return { person: tidyPerson(saved || { ...existing, ...patch }), created: false, changed };
}

function isDuplicate(result) {
  return String(result.error || '').includes('23505') || result.status === 409;
}

/**
 * Remove one field, or the whole person.
 *
 * Separate from a general update because "forget Olivia's old number" and
 * "forget Olivia" are different sizes of action, and only the second one is
 * destructive enough to be worth a confirmation.
 */
export async function forgetPerson(id, deps = {}) {
  const result = await dbRequest(
    `people?id=eq.${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: { prefer: 'return=minimal' } },
    deps
  );
  if (!result.ok) throw new PersonError(`Could not delete that person: ${result.error || result.status}`);
  return true;
}

/* ------------------------------------------------------------------- reads */

/** Case-insensitive exact match on the handle. The merge key, in query form. */
async function lookupByName(name, deps = {}) {
  const term = safeTerm(name);
  if (!term) return null;

  // ilike with no wildcards is an exact match that ignores case, which is the
  // same comparison the unique index makes.
  const result = await dbRequest(
    `people?name=ilike.${encodeURIComponent(term)}&select=*&limit=1`,
    { method: 'GET' },
    deps
  );
  if (!result.ok) throw new PersonError(`Could not look that person up: ${result.error || result.status}`);
  return (Array.isArray(result.data) ? result.data[0] : null) || null;
}

export async function getPerson(id, deps = {}) {
  const result = await dbRequest(
    `people?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { method: 'GET' },
    deps
  );
  if (!result.ok) throw new PersonError(`Could not read that person: ${result.error || result.status}`);

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row) throw new PersonError('There is nobody with that id.');
  return tidyPerson(row);
}

export async function listPeople(opts = {}, deps = {}) {
  const params = new URLSearchParams({
    select: '*',
    // Recently mentioned first: the people currently in your life, not the ones
    // that happened to be entered first.
    order: 'last_seen_at.desc',
    limit: String(Math.min(Math.max(Number(opts.limit) || 25, 1), 100)),
  });

  const term = safeTerm(opts.search);
  if (term) {
    params.set(
      'or',
      `(name.ilike.*${term}*,relationship.ilike.*${term}*,company.ilike.*${term}*)`
    );
  }

  if (opts.source && PERSON_SOURCES.includes(opts.source)) params.set('source', `eq.${opts.source}`);

  const result = await dbRequest(`people?${params}`, { method: 'GET' }, deps);
  if (!result.ok) throw new PersonError(`Could not list people: ${result.error || result.status}`);

  return (Array.isArray(result.data) ? result.data : []).map(tidyPerson);
}

/**
 * Find one person from what was actually said — "Olivia", "my sister".
 *
 * Relationship is searched as well as name, because half of how people refer to
 * each other is by role rather than by name. Same refusal-on-ambiguity rule as
 * plans: if "my brother" matches two rows, say so and name them. Handing back
 * the wrong brother's email address is the failure worth designing against.
 */
export async function findPerson(reference, deps = {}) {
  const raw = String(reference || '').trim();
  if (!raw) throw new PersonError('Who did you mean?');

  if (/^\d+$/.test(raw)) return getPerson(raw, deps);

  // "my sister" is a search for "sister". The possessive carries no information
  // here — there is one user, and everyone in this table is theirs.
  const stripped = raw.replace(/^\s*(my|our)\s+/i, '').trim();
  const term = safeTerm(stripped);
  if (!term) throw new PersonError('Who did you mean?');

  const exact = await lookupByName(term, deps);
  if (exact) return tidyPerson(exact);

  const params = new URLSearchParams({
    select: '*',
    or: `(name.ilike.*${term}*,relationship.ilike.*${term}*)`,
    limit: '10',
  });

  const result = await dbRequest(`people?${params}`, { method: 'GET' }, deps);
  if (!result.ok) throw new PersonError(`Could not search people: ${result.error || result.status}`);

  const hits = Array.isArray(result.data) ? result.data : [];
  if (!hits.length) throw new PersonError(`I have nobody on file matching "${raw}".`);
  if (hits.length === 1) return tidyPerson(hits[0]);

  throw new PersonError(
    `That matches ${hits.length} people: ${hits
      .map((p) => (p.relationship ? `${p.name} (${p.relationship})` : p.name))
      .join(', ')}. Which one?`
  );
}
