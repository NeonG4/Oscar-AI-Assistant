/**
 * lib/tools/drive.js
 * ----------------------------------------------------------------------------
 * Google Drive: find files, read what's in them, move them to the bin.
 *
 * SCOPE NOTE WORTH UNDERSTANDING
 *
 * This uses the full `drive` scope, not `drive.file`. `drive.file` is much
 * narrower — an app only ever sees files it created itself — but that makes
 * "find my lease agreement" impossible, which is the whole reason you'd ask
 * Oscar about Drive. The tradeoff is real: your refresh token can now read
 * every file in your Drive. It is mitigated the same way everything else is —
 * writes are gated, deletes ask first, and nothing is permanently destroyed.
 *
 * There is no permanent delete here, only trash. Drive keeps binned files for
 * 30 days.
 */

import { googleFetch } from '../google/auth.js';

const FILES = 'https://www.googleapis.com/drive/v3/files';

/** Text-ish types we can actually read back. */
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const EXPORTABLE = {
  [GOOGLE_DOC]: 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

const MAX_CONTENT_CHARS = 4000;

/**
 * Drive's query language delimits string literals with single quotes and offers
 * backslash escaping. Anything unescaped here would break the query or, worse,
 * change what it matches.
 */
function escapeQuery(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function friendlyType(mimeType) {
  if (!mimeType) return 'file';
  if (mimeType === GOOGLE_DOC) return 'Google Doc';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'Google Sheet';
  if (mimeType === 'application/vnd.google-apps.presentation') return 'Google Slides';
  if (mimeType === 'application/vnd.google-apps.folder') return 'folder';
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('text/')) return 'text file';
  return mimeType;
}

function tidyFile(file) {
  return {
    id: file.id,
    name: file.name,
    type: friendlyType(file.mimeType),
    mimeType: file.mimeType,
    modified: file.modifiedTime ? String(file.modifiedTime).slice(0, 10) : null,
    owner: (file.owners && file.owners[0] && file.owners[0].displayName) || undefined,
    link: file.webViewLink || undefined,
  };
}

export const searchDriveTool = {
  name: 'search_drive',
  description:
    "Find files in the user's Google Drive by name. Use for anything about their documents, files, " +
    'folders, or "where is my ...". Returns names, types and ids — call read_drive_file to see what ' +
    'is actually inside one. Set `type` to narrow to documents, spreadsheets, folders or PDFs.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words from the file name.' },
      type: {
        type: 'string',
        enum: ['any', 'document', 'spreadsheet', 'presentation', 'folder', 'pdf'],
        description: 'Narrow by kind. Defaults to any.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many. Default 10.' },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const clauses = ['trashed = false'];
    if (args.query) clauses.push(`name contains '${escapeQuery(args.query)}'`);

    const byType = {
      document: GOOGLE_DOC,
      spreadsheet: 'application/vnd.google-apps.spreadsheet',
      presentation: 'application/vnd.google-apps.presentation',
      folder: 'application/vnd.google-apps.folder',
      pdf: 'application/pdf',
    }[args.type];
    if (byType) clauses.push(`mimeType = '${byType}'`);

    const params = new URLSearchParams({
      q: clauses.join(' and '),
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))',
      orderBy: 'modifiedTime desc',
      pageSize: String(Math.min(Math.max(Number(args.limit) || 10, 1), 20)),
    });

    const data = await googleFetch(`${FILES}?${params}`, {}, ctx);
    const files = ((data && data.files) || []).map(tidyFile);

    return {
      count: files.length,
      files,
      note: files.length ? undefined : 'Nothing in Drive matches that.',
    };
  },
};

export const readDriveFileTool = {
  name: 'read_drive_file',
  description:
    'Read the text of a Drive file. Call search_drive first to get the id — never guess one. Works ' +
    'for Google Docs, Sheets, Slides and plain text. Binary files like images cannot be read; say so ' +
    'rather than guessing at their contents. Long files are truncated.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'File id from search_drive.' },
    },
    required: ['id'],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const id = encodeURIComponent(args.id);
    const meta = await googleFetch(`${FILES}/${id}?fields=id,name,mimeType,webViewLink`, {}, ctx);
    if (!meta) throw new Error('That file no longer exists.');

    const exportType = EXPORTABLE[meta.mimeType];
    const isPlainText = meta.mimeType && meta.mimeType.startsWith('text/');

    if (!exportType && !isPlainText) {
      return {
        ...tidyFile(meta),
        readable: false,
        note: `A ${friendlyType(meta.mimeType)} cannot be read as text.`,
      };
    }

    // Google-native formats must be exported; ordinary files are downloaded.
    // Both come back as plain text, which is why googleFetch needs `raw`.
    const url = exportType
      ? `${FILES}/${id}/export?mimeType=${encodeURIComponent(exportType)}`
      : `${FILES}/${id}?alt=media`;

    const text = String((await googleFetch(url, { raw: true }, ctx)) || '').trim();

    return {
      ...tidyFile(meta),
      readable: true,
      content: text.slice(0, MAX_CONTENT_CHARS),
      truncated: text.length > MAX_CONTENT_CHARS,
    };
  },
};

export const trashDriveFileTool = {
  name: 'trash_drive_file',
  description:
    'Move a Drive file to the bin. Call search_drive first for the id — never guess one. The user is ' +
    'asked to confirm first. This is recoverable: Drive keeps binned files for 30 days, and there is ' +
    'no permanent-delete tool.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'File id from search_drive.' },
    },
    required: ['id'],
    additionalProperties: false,
  },

  writes: true,
  confirm: true,

  async describe(args = {}, ctx = {}) {
    const file = await googleFetch(
      `${FILES}/${encodeURIComponent(args.id)}?fields=id,name,mimeType`,
      {},
      ctx
    );
    if (!file) throw new Error('That file no longer exists.');
    return `Move the ${friendlyType(file.mimeType)} "${file.name}" to the Drive bin?`;
  },

  async run(args = {}, ctx = {}) {
    const id = encodeURIComponent(args.id);

    let name = 'that file';
    try {
      const file = await googleFetch(`${FILES}/${id}?fields=name`, {}, ctx);
      if (file && file.name) name = `"${file.name}"`;
    } catch {
      /* proceed anyway */
    }

    // PATCH trashed=true, never DELETE. Drive's DELETE is permanent and skips
    // the bin entirely — exactly what a voice assistant should never do.
    await googleFetch(`${FILES}/${id}`, { method: 'PATCH', body: { trashed: true } }, ctx);

    return { trashed: true, id: args.id, confirmation: `Moved ${name} to the Drive bin. Recoverable for 30 days.` };
  },
};
