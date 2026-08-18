/**
 * lib/tools/gmail.js
 * ----------------------------------------------------------------------------
 * Gmail: search, read, draft, send, and move to the bin.
 *
 * THREE RULES THIS FILE FOLLOWS
 *
 *   1. Nothing is destroyed permanently. `trash_email` moves a message to the
 *      bin, where Gmail keeps it for 30 days. Gmail's API also offers a
 *      permanent delete; it is deliberately not wired up, because a voice
 *      assistant that mishears you should never be able to destroy mail
 *      irrecoverably.
 *
 *   2. Destructive actions ask first. `trash_email` is marked `confirm: true`,
 *      so it returns a signed confirmation request rather than acting — see
 *      lib/confirm.js.
 *
 *   3. Send is guarded. `send_email` is withheld unless the request proved write
 *      authority (see lib/tools/index.js), and can be further restricted to an
 *      allowlist with GOOGLE_SEND_ALLOWLIST. Sending mail as you is the most
 *      abusable thing in this project — if someone gets your Shortcut key, the
 *      difference between "spent my OpenAI credit" and "emailed my boss" is
 *      this guard.
 *
 * Message bodies are trimmed hard. A long email thread can be tens of thousands
 * of tokens, which is both slow and expensive when the answer is going to be
 * forty words on a lock screen.
 */

import { googleFetch } from '../google/auth.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 2000;

/* ------------------------------------------------------------------ helpers */

function header(message, name) {
  const headers = (message.payload && message.payload.headers) || [];
  const hit = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.value : null;
}

function decodeBase64Url(data) {
  if (!data) return '';
  try {
    return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Walk the MIME tree for the best readable body.
 * Prefers text/plain; falls back to text/html with tags stripped, because plenty
 * of senders ship HTML only.
 */
export function extractBody(payload) {
  if (!payload) return '';

  const collect = (node, out) => {
    if (!node) return;
    const type = node.mimeType || '';
    if (type === 'text/plain' && node.body && node.body.data) {
      out.plain.push(decodeBase64Url(node.body.data));
    } else if (type === 'text/html' && node.body && node.body.data) {
      out.html.push(decodeBase64Url(node.body.data));
    }
    for (const part of node.parts || []) collect(part, out);
  };

  const out = { plain: [], html: [] };
  collect(payload, out);

  let text = out.plain.join('\n').trim();
  if (!text && out.html.length) {
    text = out.html
      .join('\n')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
  }

  return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function tidyMessage(message, { includeBody = false } = {}) {
  const out = {
    id: message.id,
    threadId: message.threadId,
    from: header(message, 'From'),
    to: header(message, 'To'),
    subject: header(message, 'Subject') || '(no subject)',
    date: header(message, 'Date'),
    snippet: message.snippet ? String(message.snippet).slice(0, 300) : null,
    unread: Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD'),
  };

  if (includeBody) {
    const body = extractBody(message.payload);
    out.body = body.slice(0, MAX_BODY_CHARS);
    if (body.length > MAX_BODY_CHARS) out.bodyTruncated = true;
  }

  return out;
}

/** Non-ASCII subjects need RFC 2047 encoding or Gmail mangles them. */
function encodeSubject(subject) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/** Build an RFC 2822 message and base64url it, the way Gmail's API wants. */
export function buildRawMessage({ to, subject, body, cc, replyTo }) {
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    replyTo ? `In-Reply-To: ${replyTo}` : null,
    replyTo ? `References: ${replyTo}` : null,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
  ].filter((line) => line !== null);

  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

/** Very loose — enough to catch a mis-transcribed address, not to validate RFC 5322. */
export function looksLikeEmail(value) {
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(String(value || '').trim());
}

/**
 * Recipient allowlist. Unset means "anyone", which is why GOOGLE_SEND_ALLOWLIST
 * is worth setting even to just your own address while you're testing.
 */
export function checkRecipients(recipients, env = process.env) {
  const raw = (env.GOOGLE_SEND_ALLOWLIST || '').trim();
  if (!raw) return { allowed: true };

  const allowed = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  const blocked = recipients.filter((r) => !allowed.has(String(r).trim().toLowerCase()));
  if (blocked.length) {
    return {
      allowed: false,
      reason: `Sending to ${blocked.join(', ')} is not permitted. GOOGLE_SEND_ALLOWLIST only allows ${[...allowed].join(', ')}.`,
    };
  }
  return { allowed: true };
}

/* -------------------------------------------------------------------- tools */

export const searchEmailTool = {
  name: 'search_email',
  description:
    "Search the user's Gmail. Use for anything about their email, messages, or who has written to " +
    'them. `query` takes Gmail search syntax — e.g. "from:amazon", "is:unread", "subject:invoice", ' +
    '"newer_than:2d". Returns headers and snippets, not full bodies; call read_email for one message.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Gmail search query. Use "is:unread" for new mail, "" for the most recent.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 15, description: 'How many. Default 5.' },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 15);
    const params = new URLSearchParams({ maxResults: String(limit) });
    if (args.query) params.set('q', String(args.query).slice(0, 300));

    const list = await googleFetch(`${BASE}/messages?${params}`, {}, ctx);
    const ids = (list && list.items) || (list && list.messages) || [];

    if (!ids.length) return { count: 0, messages: [], note: 'No messages match that search.' };

    // metadata format keeps the payload small — we only need headers here.
    const metaParams =
      'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';

    const messages = await Promise.all(
      ids.slice(0, limit).map(async (m) => {
        try {
          const full = await googleFetch(`${BASE}/messages/${m.id}?${metaParams}`, {}, ctx);
          return tidyMessage(full);
        } catch {
          return null;
        }
      })
    );

    const found = messages.filter(Boolean);
    return { query: args.query || '(most recent)', count: found.length, messages: found };
  },
};

export const readEmailTool = {
  name: 'read_email',
  description:
    'Read one full email, including its body. Call search_email first to get the id — never guess ' +
    'one. Bodies are truncated, so say so if bodyTruncated is true.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Message id from search_email.' },
    },
    required: ['id'],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const message = await googleFetch(
      `${BASE}/messages/${encodeURIComponent(args.id)}?format=full`,
      {},
      ctx
    );
    return tidyMessage(message || {}, { includeBody: true });
  },
};

export const draftEmailTool = {
  name: 'draft_email',
  description:
    'Save an email as a draft in Gmail without sending it. Prefer this over send_email whenever ' +
    "the user has not clearly said to send it — a draft is recoverable and a sent message isn't.",
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'The message text.' },
    },
    required: ['to', 'subject', 'body'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    if (!looksLikeEmail(args.to)) throw new Error(`"${args.to}" is not a valid email address.`);

    const raw = buildRawMessage({
      to: String(args.to).trim(),
      subject: String(args.subject).slice(0, 300),
      body: String(args.body).slice(0, 10000),
    });

    const draft = await googleFetch(`${BASE}/drafts`, { method: 'POST', body: { message: { raw } } }, ctx);

    return {
      drafted: true,
      draftId: draft && draft.id,
      confirmation: `Draft to ${args.to} saved — it has not been sent.`,
    };
  },
};

export const sendEmailTool = {
  name: 'send_email',
  description:
    'Send an email immediately from the user\'s Gmail account. This cannot be undone. Only use it ' +
    'when the user has explicitly said to send — if there is any doubt at all, use draft_email ' +
    'instead. Always read the recipient and subject back in your answer so they can check it.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'The message text.' },
    },
    required: ['to', 'subject', 'body'],
    additionalProperties: false,
  },

  writes: true,

  async run(args = {}, ctx = {}) {
    const to = String(args.to || '').trim();
    if (!looksLikeEmail(to)) throw new Error(`"${args.to}" is not a valid email address.`);

    const gate = checkRecipients([to], ctx.env || process.env);
    if (!gate.allowed) throw new Error(gate.reason);

    const raw = buildRawMessage({
      to,
      subject: String(args.subject).slice(0, 300),
      body: String(args.body).slice(0, 10000),
    });

    const sent = await googleFetch(`${BASE}/messages/send`, { method: 'POST', body: { raw } }, ctx);

    return {
      sent: true,
      id: sent && sent.id,
      to,
      subject: args.subject,
      confirmation: `Sent to ${to} with subject "${args.subject}".`,
    };
  },
};

export const trashEmailTool = {
  name: 'trash_email',
  description:
    "Move an email to the Gmail bin. Call search_email first to get the id — never guess one. The " +
    'user is asked to confirm first. This moves the message to the bin, where Gmail keeps it for ' +
    '30 days; it is recoverable, and there is no permanent-delete tool.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Message id, from search_email.' },
    },
    required: ['id'],
    additionalProperties: false,
  },

  writes: true,
  confirm: true,

  async describe(args = {}, ctx = {}) {
    const message = await googleFetch(
      `${BASE}/messages/${encodeURIComponent(args.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      {},
      ctx
    );
    if (!message) throw new Error('That message no longer exists.');
    const from = header(message, 'From') || 'unknown sender';
    const subject = header(message, 'Subject') || '(no subject)';
    return `Move "${subject}" from ${from} to the bin?`;
  },

  async run(args = {}, ctx = {}) {
    let subject = 'that message';
    try {
      const message = await googleFetch(
        `${BASE}/messages/${encodeURIComponent(args.id)}?format=metadata&metadataHeaders=Subject`,
        {},
        ctx
      );
      const found = header(message, 'Subject');
      if (found) subject = `"${found}"`;
    } catch {
      /* proceed anyway */
    }

    // /trash, never /delete. Google's delete endpoint is permanent and
    // unrecoverable; trash keeps it for 30 days. There is no reason a voice
    // assistant should ever call the permanent one.
    await googleFetch(`${BASE}/messages/${encodeURIComponent(args.id)}/trash`, { method: 'POST' }, ctx);

    return {
      trashed: true,
      id: args.id,
      confirmation: `Moved ${subject} to the bin. Recoverable for 30 days.`,
    };
  },
};
