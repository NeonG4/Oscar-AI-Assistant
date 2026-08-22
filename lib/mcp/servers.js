/**
 * lib/mcp/servers.js
 * ----------------------------------------------------------------------------
 * The MCP servers you have connected, stored in Supabase.
 *
 * This is the part of the feature that makes Oscar growable: everything in
 * lib/tools/ was decided by whoever wrote the code, and everything in this
 * table was decided by whoever is using it. A row here is a URL, a token, and —
 * the important column — a per-tool decision about how much that tool is
 * trusted.
 *
 * THE ACCESS MODEL IS THE WHOLE DESIGN. READ THIS BEFORE CHANGING ANYTHING.
 *
 * Every built-in tool is hand-labelled `writes` and `confirm` by someone who
 * read what it does. That labelling is what keeps the read-only "Ask Oscar"
 * Shortcut from sending mail or touching the laptop — see lib/tools/index.js.
 * A tool discovered over MCP arrives with none of it.
 *
 * MCP does define annotations — readOnlyHint, destructiveHint — but they are
 * declared by the server, which is the thing being gated. A server that wanted
 * to slip past would simply say readOnlyHint: true. So they are recorded and
 * SHOWN to you, and they decide nothing. Same principle as the runner: the
 * trusting side makes the decision, not the side asking to be trusted.
 *
 * Which leaves four states per tool, and the default is the strictest one:
 *
 *   off    Withheld entirely. The model is never told the tool exists, so it
 *          cannot be argued into trying. THIS IS THE DEFAULT for every newly
 *          discovered tool — connecting a server grants nothing by itself.
 *   ask    Offered, needs write authority, and every call is read back to you
 *          before it happens. The setting to reach for when you have not
 *          personally read what the tool does.
 *   read   Offered to everything, including the read-only Shortcut, with no
 *          confirmation. Only for tools you have checked genuinely cannot
 *          change anything — this is the one state that widens the weakest key
 *          in the system, so it should be rare and deliberate.
 *   open   Offered with write authority, no confirmation. It acts on the world
 *          the moment the model decides to.
 *
 * `off` as the default is a deliberate cost: connecting a fifteen-tool server
 * means fifteen decisions. Everything else was some version of "trust it and
 * hope", and hope is not a permission model.
 */

import { dbRequest, isConfigured } from '../db.js';
import { parseServerUrl } from './client.js';

export { isConfigured as isMcpConfigured };

/** The table. Not configurable — it is created by db/schema.sql under this name. */
const TABLE = 'mcp_servers';

/** How many servers may be connected at once. */
export const MAX_SERVERS = 8;

export class McpServerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'McpServerError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ access */

/** In order of how much they grant. See the header. */
export const ACCESS_LEVELS = ['off', 'ask', 'read', 'open'];

/** Withheld. A newly discovered tool grants nothing until you say otherwise. */
export const DEFAULT_ACCESS = 'off';

/** Shown under each choice, so the UI and the API cannot drift apart. */
export const ACCESS_DESCRIPTIONS = {
  off: 'Withheld. Oscar is never told this tool exists.',
  ask: 'Offered, and every call is read back to you before it runs.',
  read: 'Offered to everything, including the Shortcut, with no confirmation. Read-only tools only.',
  open: 'Offered with write authority and no confirmation. It acts the moment Oscar decides to.',
};

/**
 * Anything unrecognised becomes `off`.
 *
 * Note the direction: a corrupted value, a typo, a level invented by a future
 * version reading an older row — all of them land on the state that grants
 * nothing. There is no input to this function that can accidentally widen what
 * Oscar may do.
 */
export function normalizeAccess(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return ACCESS_LEVELS.includes(text) ? text : DEFAULT_ACCESS;
}

/** The access map for one server, with every unknown key normalized away. */
export function normalizeAccessMap(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [name, level] of Object.entries(map)) {
    const key = String(name).slice(0, 120);
    if (!key) continue;
    out[key] = normalizeAccess(level);
  }
  return out;
}

/* ------------------------------------------------------------------ naming */

/**
 * The prefix a server's tools get, derived from its label.
 *
 * OpenAI tool names have to match [a-zA-Z0-9_-]{1,64} and be unique across the
 * whole list, and nothing stops a remote server from calling its tool
 * `send_email` and quietly shadowing yours. Prefixing removes both problems at
 * once, and it has a second benefit worth as much: the model — and you, reading
 * the activity log — can see which server an action went to.
 */
export function slugify(label) {
  const slug = String(label == null ? '' : label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  return slug || 'mcp';
}

/**
 * Oscar's name for a remote tool: `<server slug>__<tool name>`.
 *
 * Truncated from the FRONT of the remote name when it is too long, because the
 * distinguishing part of a name like `create_issue_with_attachments` is at the
 * start, and 64 characters is a limit worth respecting rather than hoping about.
 */
export function prefixedName(slug, toolName) {
  const clean = String(toolName == null ? '' : toolName).replace(/[^a-zA-Z0-9_-]/g, '_');
  const room = 64 - slug.length - 2;
  return `${slug}__${clean.slice(0, Math.max(room, 1))}`;
}

/* ------------------------------------------------------------------- rows */

function cleanLabel(value) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) throw new McpServerError('That server needs a name.');
  return text.slice(0, 60);
}

/**
 * A row as the browser is allowed to see it.
 *
 * The token never leaves this process. `hasToken` is enough for the UI to say
 * "authenticated" and to offer a Replace button, and there is no reading it
 * back out — a secret that can be fetched from an API is a secret with a much
 * larger blast radius than one that can only be overwritten.
 */
export function publicServer(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    slug: row.slug,
    url: row.url,
    enabled: row.enabled !== false,
    hasToken: Boolean(row.token),
    serverName: row.server_name || null,
    tools: Array.isArray(row.tools) ? row.tools : [],
    access: normalizeAccessMap(row.access),
    refreshedAt: row.refreshed_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at || null,
  };
}

const SELECT =
  'id,created_at,updated_at,label,slug,url,token,enabled,tools,access,server_name,refreshed_at,last_error';

function fail(result, what) {
  throw new McpServerError(
    `Could not ${what}: ${result.error || `HTTP ${result.status}`}`,
    result.status === 404 ? 400 : 500
  );
}

/**
 * Every connected server, tokens included.
 *
 * Internal — api/mcp.js maps through publicServer() before answering. Ordered
 * by id so the list on the page does not reshuffle itself when you edit one.
 */
export async function listServers(deps = {}) {
  if (!isConfigured(deps.env || process.env)) return [];
  const result = await dbRequest(`${TABLE}?select=${SELECT}&order=id.asc`, { method: 'GET' }, deps);
  if (!result.ok) fail(result, 'read your connected servers');
  return Array.isArray(result.data) ? result.data : [];
}

export async function getServer(id, deps = {}) {
  const key = Number(id);
  if (!Number.isFinite(key)) throw new McpServerError('That is not a server id.');
  const result = await dbRequest(
    `${TABLE}?select=${SELECT}&id=eq.${key}&limit=1`,
    { method: 'GET' },
    deps
  );
  if (!result.ok) fail(result, 'read that server');
  const rows = Array.isArray(result.data) ? result.data : [];
  if (!rows.length) throw new McpServerError('There is no connected server with that id.', 404);
  return rows[0];
}

/**
 * Connect a new server.
 *
 * Stored with no tools and nothing enabled — discovery is a separate step, so
 * that a server which is unreachable right now is still saved and can be
 * refreshed later rather than making you type the URL again.
 */
export async function addServer({ label, url, token }, deps = {}) {
  const env = deps.env || process.env;
  if (!isConfigured(env)) {
    throw new McpServerError('No database is configured, so there is nowhere to keep this.', 400);
  }

  const existing = await listServers(deps);
  if (existing.length >= MAX_SERVERS) {
    throw new McpServerError(`Oscar will hold ${MAX_SERVERS} servers at once. Remove one first.`);
  }

  const name = cleanLabel(label);
  const slug = slugify(name);

  if (existing.some((row) => row.slug === slug)) {
    throw new McpServerError(`Another server is already called "${name}". Pick a different name.`);
  }

  // Checked BEFORE the row is written, unlike a server that simply will not
  // answer — that one is saved so you can refresh it later rather than typing
  // the URL again. A plaintext URL is a different kind of wrong: the token
  // would go over the wire in the clear the first time anyone pressed Refresh,
  // so it must never become a row at all.
  const endpoint = parseServerUrl(url);

  const row = {
    label: name,
    slug,
    url: endpoint.toString().slice(0, 500),
    token: token ? String(token).trim().slice(0, 4000) : null,
    enabled: true,
    tools: [],
    access: {},
  };

  const result = await dbRequest(
    TABLE,
    {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(row),
    },
    deps
  );
  if (!result.ok) fail(result, 'save that server');
  clearServerCache();
  return (Array.isArray(result.data) ? result.data[0] : result.data) || row;
}

/** Change one server. Only the fields named are touched. */
export async function updateServer(id, patch, deps = {}) {
  const key = Number(id);
  if (!Number.isFinite(key)) throw new McpServerError('That is not a server id.');

  const row = { updated_at: new Date().toISOString() };
  if (patch.enabled !== undefined) row.enabled = patch.enabled === true;
  if (patch.token !== undefined) row.token = patch.token ? String(patch.token).slice(0, 4000) : null;
  if (patch.tools !== undefined) row.tools = patch.tools;
  if (patch.access !== undefined) row.access = normalizeAccessMap(patch.access);
  if (patch.serverName !== undefined) row.server_name = patch.serverName || null;
  if (patch.refreshedAt !== undefined) row.refreshed_at = patch.refreshedAt;
  if (patch.lastError !== undefined) {
    row.last_error = patch.lastError ? String(patch.lastError).slice(0, 400) : null;
  }

  const result = await dbRequest(
    `${TABLE}?id=eq.${key}`,
    {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(row),
    },
    deps
  );
  if (!result.ok) fail(result, 'save that change');
  clearServerCache();
  const rows = Array.isArray(result.data) ? result.data : [];
  if (!rows.length) throw new McpServerError('There is no connected server with that id.', 404);
  return rows[0];
}

export async function deleteServer(id, deps = {}) {
  const key = Number(id);
  if (!Number.isFinite(key)) throw new McpServerError('That is not a server id.');
  const result = await dbRequest(`${TABLE}?id=eq.${key}`, { method: 'DELETE' }, deps);
  if (!result.ok) fail(result, 'remove that server');
  clearServerCache();
  return true;
}

/**
 * Write down what a server said it can do.
 *
 * ACCESS SURVIVES A REFRESH, and that is the point of the merge below. A tool
 * you marked `read` last week stays `read` when its description changes, and a
 * tool that has APPEARED since the last refresh arrives at `off` like any other
 * new one. So a server cannot widen its own permissions by adding a tool and
 * waiting for you to hit refresh — the new tool is simply there, withheld,
 * until you look at it.
 */
export async function saveDiscovery(id, { tools, serverName, error }, deps = {}) {
  const row = await getServer(id, deps);
  const previous = normalizeAccessMap(row.access);
  const access = {};

  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool && tool.name;
    if (!name) continue;
    access[name] = previous[name] || DEFAULT_ACCESS;
  }

  return updateServer(
    id,
    {
      tools: Array.isArray(tools) ? tools : [],
      access,
      serverName,
      refreshedAt: new Date().toISOString(),
      lastError: error || null,
    },
    deps
  );
}

/* ------------------------------------------------------------------- cache */

/**
 * How long a server list is reused before going back to the database.
 *
 * The tool registry asks on every request, so without this every question would
 * spend a round trip re-reading rows that change about once a month. Thirty
 * seconds is short enough that turning a tool off feels immediate and long
 * enough that the traffic disappears.
 *
 * The direction of staleness is the thing to check when changing this number.
 * A stale cache can leave a tool available for up to thirty seconds after you
 * switched it off. Every write in this file clears the cache, so the instance
 * you clicked on applies the change at once — but serverless means the others
 * each hold their own copy and expire at their own moment, exactly as the
 * caches in lib/settings.js do. Thirty seconds is the real revocation delay,
 * which is why this holds a preference and never a permission: what a tool may
 * do is decided from the row at the moment it is loaded, not from anything
 * cached about the request.
 */
const CACHE_MS = 30000;

let cached = null;

export function clearServerCache() {
  cached = null;
}

/**
 * The enabled servers, cached, never throwing.
 *
 * Failure comes back as an empty list, on the same rule as lib/db.js: a
 * database that is having a bad afternoon costs you your extra tools, not your
 * answer. The built-ins are all still there.
 */
export async function loadEnabledServers(deps = {}) {
  const env = deps.env || process.env;
  if (!isConfigured(env)) return [];

  const now = deps.now || Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.rows;

  let rows = [];
  try {
    rows = (await listServers(deps)).filter((row) => row.enabled !== false);
  } catch (err) {
    console.error(`[oscar] could not read MCP servers: ${(err && err.message) || err}`);
    rows = [];
  }

  cached = { at: now, rows };
  return rows;
}
