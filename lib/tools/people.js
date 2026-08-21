/**
 * lib/tools/people.js
 * ----------------------------------------------------------------------------
 * The people you know: asked for out loud, rather than picked up in passing.
 *
 *   "Olivia is my sister, add that to her contact information"
 *      → remember_person
 *   "what's my sister's email?"
 *      → get_person
 *   "who do I know at Acme?"
 *      → list_people
 *
 * THE LINE BETWEEN THESE TOOLS AND lib/catch.js IS THE WHOLE FEATURE
 *
 * Background catching writes to the same table, from the same merge function,
 * with the same rules — but it happens because you SAID something, and it can
 * be switched off. These tools happen because you ASKED, and they cannot: a
 * direct request is always honoured, whatever the toggle says. That is why
 * `remember_person`'s description is so insistent that the model only call it
 * when asked. If the model started saving everyone it heard about, the setting
 * would quietly stop meaning anything, which is a worse outcome than the
 * feature simply being off.
 *
 * Reading is free; only writing needs write authority, the same split as plans.
 */

import {
  rememberPerson,
  findPerson,
  listPeople,
  forgetPerson,
  PersonError,
} from '../people.js';

/** Shared between remember_person's schema and nothing else, but long enough to name. */
const PERSON_FIELDS = {
  name: {
    type: 'string',
    description: 'What the user calls them — "Olivia", "Dr Ruiz". Not a description, just the name.',
  },
  fullName: { type: 'string', description: 'Their full name, if the user gave one.' },
  relationship: {
    type: 'string',
    description: 'How the user knows them: "sister", "boss at Acme", "friend from university".',
  },
  emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses.' },
  phones: { type: 'array', items: { type: 'string' }, description: 'Phone numbers, as said.' },
  birthday: { type: 'string', description: 'Their birthday, however the user put it — "March 4".' },
  company: { type: 'string', description: 'Where they work.' },
  role: { type: 'string', description: 'What they do there.' },
  location: { type: 'string', description: 'Where they live.' },
  notes: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Anything else durable, one short fact each. Never anything temporary — not how they ' +
      'are feeling, not what they are doing this week.',
  },
};

export const rememberPersonTool = {
  name: 'remember_person',
  description:
    'Save or update someone in the user\'s contacts. Use ONLY when the user actually asks for ' +
    'something to be remembered or added — "Olivia is my sister, add that", "save Dan\'s number", ' +
    '"her email is x@y.com, note that down". ' +
    'Do NOT call this just because a person came up in conversation. Mentioning someone is not a ' +
    'request to file them, and the user has a separate setting that decides whether passing ' +
    'mentions are recorded. Calling this uninvited overrides a choice that was theirs to make. ' +
    'Merges into an existing person of the same name rather than duplicating them, so use it for ' +
    'updates too. Record only what the user said; never fill in a field by guessing.',
  parameters: {
    type: 'object',
    properties: PERSON_FIELDS,
    required: ['name'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    // Explicit, so this one may overwrite. A fact the user has just stated
    // outranks anything Oscar previously inferred, which is the opposite of
    // how lib/catch.js's writes are treated.
    const { person, created, changed } = await rememberPerson(
      args,
      { source: 'explicit', overwrite: true },
      ctx
    );

    return {
      saved: true,
      created,
      person,
      confirmation: created
        ? `Saved ${person.name}${person.relationship ? ` as your ${person.relationship}` : ''}.`
        : changed.length
        ? `Updated ${person.name}.`
        : `Already had that for ${person.name}.`,
    };
  },
};

export const listPeopleTool = {
  name: 'list_people',
  description:
    'List the people the user knows. Use for "who do I know", "who have I got on file", "who do ' +
    'I know at Acme". Searches names, relationships and companies. Returns the most recently ' +
    'mentioned first. For one person in full, use get_person.',
  parameters: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Optional words to match against name, relationship or company.',
      },
      source: {
        type: 'string',
        enum: ['explicit', 'background'],
        description:
          'Optional. "background" shows only people Oscar picked up from conversation rather ' +
          'than being told about directly — use it for "what have you noticed about my contacts".',
      },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const people = await listPeople(args, ctx);
    return {
      count: people.length,
      people,
      note: people.length ? undefined : 'Nobody saved yet.',
    };
  },
};

export const getPersonTool = {
  name: 'get_person',
  description:
    'Look one person up: how the user knows them, their email, phone, and anything else on file. ' +
    'Use for "what\'s my sister\'s email", "what do you know about Dan", "what is Olivia\'s ' +
    'number". Refer to them however the user did — a name ("Olivia") or a relationship ("my ' +
    'sister") both work. If more than one person matches, this refuses and names them rather ' +
    'than guessing; pass the answer back once the user has said which.',
  parameters: {
    type: 'object',
    properties: {
      person: {
        type: 'string',
        description: 'The name or relationship, as the user said it. "Olivia" or "my sister".',
      },
    },
    required: ['person'],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    return findPerson(args.person, ctx);
  },
};

export const forgetPersonTool = {
  name: 'forget_person',
  description:
    'Delete someone from the user\'s contacts entirely, with everything on file about them. Use ' +
    'when the user asks to forget or remove a person. The user is asked to confirm first. If they ' +
    'only want one detail corrected, use remember_person instead — it overwrites.',
  parameters: {
    type: 'object',
    properties: {
      person: { type: 'string', description: 'The name or relationship, as the user said it.' },
    },
    required: ['person'],
    additionalProperties: false,
  },

  writes: true,
  confirm: true,

  /**
   * Read-only, and specific about what is about to be lost. "Delete Olivia?" is
   * a much easier yes than "delete Olivia (sister), 2 emails, 1 phone number".
   */
  async describe(args = {}, ctx = {}) {
    const person = await findPerson(args.person, ctx);
    const bits = [];
    if (person.emails) bits.push(`${person.emails.length} email${person.emails.length === 1 ? '' : 's'}`);
    if (person.phones) bits.push(`${person.phones.length} phone number${person.phones.length === 1 ? '' : 's'}`);
    if (person.notes) bits.push(`${person.notes.length} note${person.notes.length === 1 ? '' : 's'}`);

    const who = person.relationship ? `${person.name} (${person.relationship})` : person.name;
    return `Forget ${who}${bits.length ? `, along with ${bits.join(' and ')}` : ''}? This cannot be undone.`;
  },

  async run(args = {}, ctx = {}) {
    const person = await findPerson(args.person, ctx);
    if (!person || !person.id) throw new PersonError('I could not find who you meant.');

    await forgetPerson(person.id, ctx);
    return { deleted: true, confirmation: `Forgotten ${person.name}.` };
  },
};
