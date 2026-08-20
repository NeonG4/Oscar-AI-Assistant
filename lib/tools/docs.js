/**
 * lib/tools/docs.js
 * ----------------------------------------------------------------------------
 * Google Docs: create, read, and append.
 *
 * This is where Oscar puts anything too long to say out loud — a draft, a
 * write-up, research notes. The notification answer stays short; the document
 * holds the substance.
 *
 * TWO API QUIRKS THIS FILE ABSORBS
 *
 *   1. A document is a tree, not a string. Text lives in
 *      body.content[].paragraph.elements[].textRun.content, and reading it back
 *      means walking that.
 *
 *   2. You cannot insert at the document's end index. The body's final newline
 *      is a real character, and Docs rejects an insertion at or past it — you
 *      have to target endIndex - 1. Getting this wrong is the classic Docs API
 *      500, so appendToDoc computes it rather than guessing.
 *
 * There is no delete tool. To get rid of a document, use trash_drive_file —
 * which asks first and is recoverable.
 */

import { googleFetch } from '../google/auth.js';

const DOCS = 'https://docs.googleapis.com/v1/documents';
const MAX_CONTENT_CHARS = 6000;

/** Walk the document tree and pull out readable text. */
export function extractDocText(doc) {
  const out = [];

  const readElements = (elements = []) => {
    for (const el of elements) {
      if (el.textRun && el.textRun.content) out.push(el.textRun.content);
    }
  };

  const walk = (content) => {
    // Not `content = []`: a default only fires on undefined, and a missing
    // body reaches here as null, which would throw on iteration.
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.paragraph) readElements(block.paragraph.elements);
      else if (block.table) {
        for (const row of block.table.tableRows || []) {
          for (const cell of row.tableCells || []) walk(cell.content);
        }
      } else if (block.tableOfContents) walk(block.tableOfContents.content);
    }
  };

  walk(doc && doc.body && doc.body.content);
  return out.join('').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * The last index you are allowed to insert at.
 *
 * The body always ends with a newline that belongs to the document itself;
 * inserting at or beyond it is an error, so back off by one.
 */
export function endIndexOf(doc) {
  const content = (doc && doc.body && doc.body.content) || [];
  const last = content[content.length - 1];
  const end = last && typeof last.endIndex === 'number' ? last.endIndex : 1;
  return Math.max(1, end - 1);
}

function docLink(id) {
  return `https://docs.google.com/document/d/${id}/edit`;
}

export const createDocTool = {
  name: 'create_doc',
  description:
    'Create a Google Doc and write content into it. Use this whenever the user asks for something ' +
    'longer than a sentence or two — a draft, a letter, a write-up, notes, research. Your spoken ' +
    'answer is capped at a few dozen words, so put the substance in the document and just tell them ' +
    'it is ready. Write real content, not an outline of what you would write.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Document title.' },
      content: { type: 'string', description: 'The full text. Use blank lines between paragraphs.' },
    },
    required: ['title', 'content'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('A document needs a title.');

    const created = await googleFetch(DOCS, { method: 'POST', body: { title: title.slice(0, 200) } }, ctx);
    const id = created && created.documentId;
    if (!id) throw new Error('Google did not return a document id.');

    const text = String(args.content || '');
    if (text.trim()) {
      // A brand new document is empty, so index 1 is the only valid insertion
      // point — no need to fetch it back first.
      await googleFetch(
        `${DOCS}/${encodeURIComponent(id)}:batchUpdate`,
        { method: 'POST', body: { requests: [{ insertText: { location: { index: 1 }, text } }] } },
        ctx
      );
    }

    return {
      created: true,
      id,
      title,
      link: docLink(id),
      words: text.trim() ? text.trim().split(/\s+/).length : 0,
      confirmation: `Created the document "${title}".`,
    };
  },
};

export const readDocTool = {
  name: 'read_doc',
  description:
    'Read the full text of a Google Doc. Get the id from search_drive first — never guess one. Long ' +
    'documents are truncated, so say so if truncated is true.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Document id, from search_drive.' },
    },
    required: ['id'],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const doc = await googleFetch(`${DOCS}/${encodeURIComponent(args.id)}`, {}, ctx);
    if (!doc) throw new Error('That document no longer exists.');

    const text = extractDocText(doc);
    return {
      id: doc.documentId,
      title: doc.title,
      link: docLink(doc.documentId),
      content: text.slice(0, MAX_CONTENT_CHARS),
      truncated: text.length > MAX_CONTENT_CHARS,
      words: text.trim() ? text.trim().split(/\s+/).length : 0,
    };
  },
};

export const appendToDocTool = {
  name: 'append_to_doc',
  description:
    'Add text to the end of an existing Google Doc. Get the id from search_drive first. Use this to ' +
    'add to running notes or a journal rather than creating a new document each time. It only ' +
    'appends — it cannot edit or remove what is already there.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Document id.' },
      text: { type: 'string', description: 'What to add. It is appended as-is.' },
    },
    required: ['id', 'text'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    const id = encodeURIComponent(args.id);
    const doc = await googleFetch(`${DOCS}/${id}`, {}, ctx);
    if (!doc) throw new Error('That document no longer exists.');

    const addition = String(args.text || '');
    if (!addition.trim()) throw new Error('There is nothing to append.');

    // Separate the new text from what is already there, unless the document is
    // empty (endIndex 1 means no content at all).
    const index = endIndexOf(doc);
    const text = index > 1 ? `\n${addition}` : addition;

    await googleFetch(
      `${DOCS}/${id}:batchUpdate`,
      { method: 'POST', body: { requests: [{ insertText: { location: { index }, text } }] } },
      ctx
    );

    return {
      appended: true,
      id: doc.documentId,
      title: doc.title,
      link: docLink(doc.documentId),
      confirmation: `Added to "${doc.title}".`,
    };
  },
};
