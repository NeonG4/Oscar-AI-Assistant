/**
 * lib/mcp/client.js
 * ----------------------------------------------------------------------------
 * Talking to a Model Context Protocol server over HTTP.
 *
 * MCP is JSON-RPC 2.0 with three calls that matter here:
 *
 *   initialize  -> handshake, tells us the server's name and hands back a
 *                  session id we have to echo on everything after it
 *   tools/list  -> what the server can do, as name + description + JSON Schema
 *   tools/call  -> do one of them
 *
 * That is genuinely the whole protocol as far as Oscar is concerned. There is
 * no SDK here for the same reason there is no Supabase client in lib/db.js:
 * three POSTs do not justify a dependency, and `npm install` staying
 * unnecessary is a property of this project worth keeping.
 *
 * STREAMABLE HTTP ONLY, AND THAT IS A REAL LIMIT
 *
 * The 2025 transport ("streamable HTTP") is one endpoint that answers a POST
 * with either JSON or an SSE stream. That is what this speaks. The older
 * 2024-11-05 transport — a long-lived GET for events plus a separate POST
 * endpoint — is not supported, and neither is stdio, because stdio means
 * launching a process and Vercel has nowhere to launch one. A stdio server
 * belongs on the laptop with the runner; see MCP.md.
 *
 * WHAT COMES BACK IS DATA, NEVER INSTRUCTIONS
 *
 * Everything this file returns was written by somebody else's server. It gets
 * read by a model that can send mail as you and run commands on your laptop, so
 * every remote tool defaults to asking before it acts and its output is labelled
 * as untrusted on the way into the context. lib/mcp/tools.js is where both of
 * those live. This file is only the wire.
 */

/**
 * The protocol version we claim. Servers negotiate down; one that only speaks
 * something older answers with its own version and we carry on with it, because
 * tools/list and tools/call have not changed shape across any of them.
 */
export const PROTOCOL_VERSION = '2025-06-18';

/** How long any single request to a third party may take. */
export const TIMEOUT_MS = 12000;

/**
 * Caps on what a server may hand back.
 *
 * Not paranoia about disk — this text goes into a model's context window, which
 * is both expensive and finite, and a tools/list with four hundred tools would
 * cost more per question than everything else Oscar does put together.
 */
export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_TOOLS = 60;

export class McpError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'McpError';
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ the URL */

/**
 * An address we are willing to POST to.
 *
 * https only, except on localhost, which is there so you can point at a server
 * running beside `vercel dev` while you are building one. Everything else is a
 * refusal rather than a warning: this URL is about to be given a bearer token
 * and asked to influence a model that can act on your behalf, and sending that
 * over plaintext http to an arbitrary host is not a thing to be talked into.
 *
 * @returns {URL}
 */
export function parseServerUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new McpError('That server needs a URL.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new McpError('That is not a URL Oscar can read.');
  }

  const local =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new McpError('An MCP server has to be https (or http on localhost).');
  }

  return url;
}

/* ------------------------------------------------------------ the transport */

let nextId = 1;

function rpc(method, params) {
  return { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) };
}

/**
 * Pull the JSON-RPC message out of a response body.
 *
 * A streamable-HTTP server may answer a POST with `application/json` (one
 * message, done) or with `text/event-stream` (a sequence of SSE frames, the
 * last of which carries the reply). Both are legal for the same request, so
 * both are handled here rather than at the call sites.
 */
export function parseRpcBody(text, contentType = '') {
  const body = String(text == null ? '' : text);
  if (!body.trim()) return null;

  if (!String(contentType).includes('text/event-stream')) {
    try {
      return JSON.parse(body);
    } catch {
      throw new McpError('The server answered with something that was not JSON.');
    }
  }

  // SSE: frames separated by a blank line, payload on `data:` lines. A frame's
  // data may be split across several lines, which the spec says to join with
  // newlines before parsing.
  let last = null;
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      // Notifications and progress updates stream past on the way to the real
      // answer; the one carrying a result or an error is the one we came for.
      if (message && (message.result !== undefined || message.error !== undefined)) return message;
      last = message;
    } catch {
      // A frame we cannot read is not fatal on its own — keep looking for one
      // we can.
    }
  }
  return last;
}

/**
 * One JSON-RPC round trip.
 *
 * @param {{url: URL|string, token?: string, sessionId?: string, protocolVersion?: string}} server
 * @returns {Promise<{message: object|null, sessionId?: string, status: number}>}
 */
async function post(server, payload, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const budget = deps.timeoutMs || TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);

  const headers = {
    'content-type': 'application/json',
    // Both, because the server picks. Omitting either is grounds for a 406.
    accept: 'application/json, text/event-stream',
  };
  if (server.token) headers.authorization = `Bearer ${server.token}`;
  if (server.sessionId) headers['mcp-session-id'] = server.sessionId;
  if (server.protocolVersion) headers['mcp-protocol-version'] = server.protocolVersion;

  let res;
  try {
    res = await doFetch(String(server.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    throw new McpError(
      aborted
        ? `The server did not answer within ${Math.round(budget / 1000)}s.`
        : `Could not reach the server: ${(err && err.message) || err}`
    );
  } finally {
    clearTimeout(timer);
  }

  const header = (name) => (res.headers && res.headers.get ? res.headers.get(name) : null);
  const sessionId = header('mcp-session-id') || undefined;

  // 202 with no body is the correct answer to a notification.
  if (res.status === 202) return { message: null, sessionId, status: res.status };

  const raw = await res.text().catch(() => '');
  if (raw.length > MAX_BODY_BYTES) {
    throw new McpError('The server sent back more than Oscar is willing to read.');
  }

  if (!res.ok) {
    // A JSON-RPC error inside a non-2xx body is more informative than the
    // status line, so try for it before falling back.
    let detail = raw.slice(0, 200);
    try {
      const parsed = parseRpcBody(raw, header('content-type') || '');
      if (parsed && parsed.error && parsed.error.message) detail = parsed.error.message;
    } catch {
      /* keep the raw text */
    }
    throw new McpError(
      res.status === 401 || res.status === 403
        ? `The server refused Oscar's credentials (HTTP ${res.status}).`
        : `The server returned HTTP ${res.status}${detail ? `: ${detail}` : ''}.`,
      { status: res.status }
    );
  }

  const message = parseRpcBody(raw, header('content-type') || '');
  if (message && message.error) {
    throw new McpError(message.error.message || 'The server refused that call.', {
      code: message.error.code,
    });
  }

  return { message, sessionId, status: res.status };
}

/* ------------------------------------------------------------ the handshake */

/**
 * Say hello, and come back with whatever the session needs from here on.
 *
 * The `notifications/initialized` that follows is required by the spec and its
 * failure is deliberately swallowed: some servers answer it with a 405 and then
 * work perfectly well, and refusing to talk to them over a notification nobody
 * reads would be pedantry at your expense.
 *
 * @returns {Promise<{sessionId?: string, protocolVersion: string, serverName?: string}>}
 */
export async function connect(server, deps = {}) {
  const target = { url: parseServerUrl(server.url), token: server.token };

  const { message, sessionId } = await post(
    target,
    rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'oscar', version: '1.0.0' },
    }),
    deps
  );

  const result = (message && message.result) || {};
  const info = result.serverInfo || {};
  const session = {
    sessionId,
    protocolVersion: result.protocolVersion || PROTOCOL_VERSION,
    serverName: info.name ? String(info.name).slice(0, 80) : undefined,
  };

  try {
    await post(
      { ...target, sessionId: session.sessionId, protocolVersion: session.protocolVersion },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      deps
    );
  } catch {
    /* see above — not worth failing a working server over */
  }

  return session;
}

/* ------------------------------------------------------------------ listing */

/**
 * Every tool the server offers, as it describes itself.
 *
 * Paginated, because a server with a hundred tools hands them over in pages —
 * though MAX_TOOLS stops us long before that becomes interesting.
 *
 * @returns {Promise<{tools: object[], session: object, truncated: boolean}>}
 */
export async function listTools(server, deps = {}) {
  const session = server.sessionId ? server : await connect(server, deps);
  const target = {
    url: parseServerUrl(server.url),
    token: server.token,
    sessionId: session.sessionId,
    protocolVersion: session.protocolVersion,
  };

  const tools = [];
  let cursor;
  let truncated = false;

  // Four pages is plenty for MAX_TOOLS, and it is a hard stop against a server
  // that hands back a cursor pointing at itself forever.
  for (let page = 0; page < 4; page += 1) {
    const { message } = await post(target, rpc('tools/list', cursor ? { cursor } : {}), deps);
    const result = (message && message.result) || {};
    const batch = Array.isArray(result.tools) ? result.tools : [];

    for (const tool of batch) {
      if (tools.length >= MAX_TOOLS) {
        truncated = true;
        break;
      }
      tools.push(tool);
    }

    cursor = result.nextCursor;
    if (!cursor || truncated) break;
  }

  return { tools, session, truncated };
}

/* ------------------------------------------------------------------ calling */

/**
 * Flatten a tool result into something a language model can read.
 *
 * MCP results are a list of typed content blocks. Text comes through as text;
 * an image or an audio block becomes a note that one was returned, because
 * there is nothing useful to put in a notification body about a PNG and
 * base64 in the context window is pure cost.
 */
export function flattenContent(result) {
  const blocks = Array.isArray(result && result.content) ? result.content : [];
  const parts = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[the tool returned an image]');
    else if (block.type === 'audio') parts.push('[the tool returned audio]');
    else if (block.type === 'resource_link' && block.uri) parts.push(`[resource: ${block.uri}]`);
    else if (block.type === 'resource' && block.resource) {
      const text = block.resource.text;
      parts.push(typeof text === 'string' ? text : `[resource: ${block.resource.uri || 'binary'}]`);
    }
  }

  // Some servers return only structuredContent and no text blocks at all.
  if (!parts.length && result && result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent));
    } catch {
      /* nothing readable in there */
    }
  }

  return parts.join('\n').trim();
}

/**
 * Run one tool on the server.
 *
 * `isError: true` is the protocol's way of saying the tool ran and failed —
 * which is different from the call failing, and is information the model should
 * be given rather than an exception it cannot see. So it comes back as a flag
 * rather than a throw.
 *
 * @param {{url, token?, sessionId?, protocolVersion?}} server
 * @param {string} name  the tool's own name, NOT Oscar's prefixed one
 * @param {object} args
 * @returns {Promise<{text: string, isError: boolean, structured?: any, session: object}>}
 */
export async function callTool(server, name, args, deps = {}) {
  const session = server.sessionId ? server : await connect(server, deps);
  const target = {
    url: parseServerUrl(server.url),
    token: server.token,
    sessionId: session.sessionId,
    protocolVersion: session.protocolVersion,
  };

  const { message } = await post(
    target,
    rpc('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }),
    deps
  );

  const result = (message && message.result) || {};
  return {
    text: flattenContent(result),
    isError: result.isError === true,
    structured: result.structuredContent,
    session,
  };
}
