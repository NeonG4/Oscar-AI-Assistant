/**
 * lib/catch.js
 * ----------------------------------------------------------------------------
 * Background catching: noticing the people you mention, without being asked.
 *
 * "I'm writing to my sister, Olivia, who has a cold. What's the best way to
 * talk to her?" is a question about tone. It is also, incidentally, the fact
 * that you have a sister called Olivia — and next week, when you say "email
 * Olivia", that fact is the difference between Oscar knowing who you mean and
 * asking you.
 *
 * So this runs after an answer, reads what you said, and writes anything
 * durable about a person into `people` (lib/people.js). Nothing about it
 * appears in the answer: it is a side effect of talking, which is the entire
 * point. If it had to announce itself it would just be a slower way of asking
 * you to fill in a contact form.
 *
 * IT IS OFF UNTIL YOU TURN IT ON. See getBackgroundCatching() in
 * lib/settings.js. With it off this module is a no-op and the explicit tools
 * (lib/tools/people.js) still work — "Olivia is my sister, add that to her
 * contact information" is a request, and requests are always honoured.
 *
 * FOUR RULES, ALL OF WHICH ARE ABOUT NOT BEING CREEPY OR WRONG
 *
 *   1. ONLY YOUR WORDS. The question is read; the answer is not. Oscar's own
 *      prose is generated text, and generated text contains invented details.
 *      Feeding it back into a database that Oscar later treats as fact is how
 *      you end up with an address book full of things nobody ever said.
 *
 *   2. ONLY DURABLE FACTS. Who someone is to you, how to reach them, where they
 *      work, when their birthday is. NOT how they are today. "Olivia has a
 *      cold" is true for a week and misleading forever after, and an assistant
 *      that raises a cold from last March is worse than one that never
 *      listened. This is the rule most likely to be got wrong by a model, so
 *      the prompt below spends most of its length on it.
 *
 *   3. NEVER OVERWRITE WHAT YOU SAID YOURSELF. Everything caught here is stored
 *      with source 'background', which mergePerson() treats as allowed to fill
 *      an empty field and never allowed to replace a full one. A misheard
 *      sentence can therefore add something you can see and delete; it cannot
 *      quietly rewrite what you already told him.
 *
 *   4. NEVER BREAK THE ANSWER. Every failure in here is swallowed and logged,
 *      exactly like lib/db.js. The question has already been answered by the
 *      time this runs; an extraction that times out must not turn a good answer
 *      into an error.
 */

import { getBackgroundCatching } from './settings.js';
import { rememberPerson, isPeopleConfigured } from './people.js';

/** Long enough for a small model on two sentences; short enough not to hang. */
export const CATCH_TIMEOUT_MS = 8000;

/** A hard ceiling per turn. Nobody introduces six new people in one sentence. */
export const MAX_PEOPLE_PER_TURN = 4;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export function catchModel(env = process.env) {
  return env.OSCAR_CATCH_MODEL || env.OSCAR_FAST_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini';
}

/**
 * Words that mean somebody is being talked about as a person you know.
 *
 * Kept in one list because it is the thing most worth editing later: if Oscar
 * keeps missing your godmother, this is the line to add her to.
 */
const RELATIONSHIP_WORDS =
  'sister|brother|sibling|mum|mom|mother|dad|father|parent|wife|husband|spouse|partner|girlfriend|boyfriend|fianc[ée]e?|son|daughter|kid|child|aunt|uncle|cousin|niece|nephew|grandma|grandmother|grandpa|grandfather|granddaughter|grandson|in-law|stepmother|stepfather|stepson|stepdaughter|boss|manager|colleague|coworker|co-worker|teammate|assistant|client|customer|landlord|tenant|neighbour|neighbor|friend|mate|roommate|flatmate|housemate|doctor|dentist|therapist|accountant|lawyer|solicitor|agent|tutor|teacher|professor|student|barber|hairdresser|mechanic|plumber|electrician';

/**
 * Is this sentence worth spending a model call on?
 *
 * The same trick as the router's keyword short-circuit, and for the same
 * reason: most of what you ask Oscar is "what's the weather", and paying for an
 * extraction call on every one of those would be a tax on the fast path for no
 * return.
 *
 * DELIBERATELY CONSERVATIVE IN THE CHEAP DIRECTION. It fires on strong evidence
 * and misses quiet mentions — "Tom moved to Denver" has no marker in it and
 * will not be caught. That asymmetry is right: a missed fact costs you one
 * sentence to state explicitly, while a model call on every "set a timer" costs
 * money and latency forever.
 */
export function worthCatching(text) {
  const said = String(text || '');
  if (said.trim().length < 8) return false;

  // An email address or a phone number is contact information by definition.
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(said)) return true;
  if (/(?:\+?\d[\d\s().-]{7,}\d)/.test(said)) return true;

  // "my sister", "her boss", "our neighbour" — someone in a role, in your life.
  const possessive = new RegExp(`\\b(my|our|his|her|their)\\s+(${RELATIONSHIP_WORDS})\\b`, 'i');
  if (possessive.test(said)) return true;

  // "Olivia is my sister" — the relationship stated the other way round.
  const isA = new RegExp(`\\bis\\s+(my|our)\\s+(${RELATIONSHIP_WORDS})\\b`, 'i');
  if (isA.test(said)) return true;

  // Facts that are only ever said about a person.
  if (/\b(?:works?|working)\s+(?:at|for)\b/i.test(said)) return true;
  if (/\b(?:his|her|their)\s+(?:birthday|number|email|address|phone)\b/i.test(said)) return true;
  if (/\b(?:name|surname)\s+is\b/i.test(said)) return true;
  if (/\b(?:met|introduced to|introduce me to)\b/i.test(said)) return true;

  return false;
}

const SYSTEM = [
  'You extract durable facts about PEOPLE from something a user said to their assistant.',
  'Reply with JSON only: {"people": [...]}. An empty list is the normal answer and is',
  'always better than a guess.',
  '',
  'Each person may have: name (required), fullName, relationship, emails (array),',
  'phones (array), birthday, company, role, location, notes (array of short strings).',
  '',
  'RECORD ONLY WHAT IS STILL TRUE IN A YEAR.',
  '  yes — "my sister Olivia"            -> {name: "Olivia", relationship: "sister"}',
  '  yes — "Olivia works at Acme"        -> {name: "Olivia", company: "Acme"}',
  '  yes — "Dan\'s number is 555 0142"   -> {name: "Dan", phones: ["555 0142"]}',
  '  yes — "my dentist, Dr Ruiz"         -> {name: "Dr Ruiz", relationship: "dentist"}',
  '  NO  — "Olivia has a cold"            temporary. Skip it entirely.',
  '  NO  — "Olivia is annoyed with me"    a mood, not a fact.',
  '  NO  — "Olivia is coming on Tuesday"  an event, not a fact.',
  'A person mentioned only in a temporary context is still worth recording for their',
  'NAME and RELATIONSHIP. The passing detail is what you drop, not the person.',
  '',
  'NEVER record:',
  '- the user themselves, or anyone unnamed ("my boss" with no name is not a person yet)',
  '- public figures, celebrities, politicians, authors, or fictional characters',
  '- companies, products, pets, places, or teams',
  '- anything the user asked ABOUT rather than stated ("who is Ada Lovelace")',
  '- anything you inferred rather than read. If it is not in the text, it does not exist.',
  '',
  'Names are as the user says them: "Olivia", not "Olivia (sister)". Put a fuller name in',
  'fullName. Keep notes to at most one short factual clause each, and omit notes entirely',
  'unless there is something durable that no other field fits.',
].join('\n');

/**
 * Ask the model who was mentioned.
 *
 * @returns {Promise<Array<object>>} raw people objects, unvalidated beyond shape.
 *          Cleaning is lib/people.js's job — this only guarantees an array.
 */
export async function extractPeople(text, deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATCH_TIMEOUT_MS);

  try {
    const res = await doFetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: catchModel(env),
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: String(text).slice(0, 2000) },
        ],
        // Zero, because this is extraction rather than writing. The same
        // sentence should produce the same row every time it is said.
        temperature: 0,
        response_format: { type: 'json_object' },
        max_tokens: 400,
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = JSON.parse(await res.text());
    const content = (((payload.choices || [])[0] || {}).message || {}).content || '';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }

    const people = Array.isArray(parsed) ? parsed : parsed && parsed.people;
    if (!Array.isArray(people)) return [];

    return people.filter((p) => p && typeof p === 'object').slice(0, MAX_PEOPLE_PER_TURN);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole pass: should we, is there anything, write it down.
 *
 * Never throws and never rejects. Callers await it purely so a serverless
 * function does not freeze mid-write — see the comment on logConversation in
 * api/ask.js for why fire-and-forget loses rows here.
 *
 * @param {{question: string}} turn   only the question. The answer is not read;
 *                                    see rule 1 at the top of this file.
 * @returns {Promise<{caught: string[], skipped?: string, error?: string}>}
 */
export async function catchPeople(turn = {}, deps = {}) {
  const env = deps.env || process.env;
  const said = String(turn.question || '').trim();

  try {
    if (!said) return { caught: [], skipped: 'nothing-said' };

    // Cheapest checks first, and in this order deliberately: the regex costs
    // nothing, the setting read is usually a cache hit, and the model call is
    // the only expensive one.
    if (!worthCatching(said)) return { caught: [], skipped: 'no-signal' };
    if (!isPeopleConfigured(env)) return { caught: [], skipped: 'no-database' };
    if (!(await getBackgroundCatching(deps))) return { caught: [], skipped: 'off' };

    const found = await extractPeople(said, deps);
    if (!found.length) return { caught: [], skipped: 'nobody-found' };

    const caught = [];
    for (const person of found) {
      try {
        // source 'background' is what makes these facts unable to overwrite
        // anything you said yourself. See mergePerson() in lib/people.js.
        const { person: saved } = await rememberPerson(person, { source: 'background' }, deps);
        if (saved) caught.push(saved.name);
      } catch (err) {
        // One unusable person does not spoil the rest of the sentence.
        console.error(`[oscar] could not catch a person: ${(err && err.message) || err}`);
      }
    }

    if (caught.length) console.log(`[oscar] caught ${caught.join(', ')}`);
    return { caught };
  } catch (err) {
    console.error(`[oscar] background catching failed: ${(err && err.message) || err}`);
    return { caught: [], error: String((err && err.message) || err) };
  }
}
