/**
 * api/mcp.js
 * ----------------------------------------------------------------------------
 * Connecting Oscar to somebody else's tools.
 *
 *   GET    /api/mcp                                  -> every connected server
 *   POST   /api/mcp { label, url, token? }           -> connect a new one
 *   POST   /api/mcp { id, refresh: true }            -> re-read its tool list
 *   POST   /api/mcp { id, access: {tool: 'ask'} }    -> decide what it may do
 *   POST   /api/mcp { id, enabled: false }           -> switch the whole server off
 *   POST   /api/mcp { id, token: '...' }             -> replace its credentials
 *   DELETE /api/mcp?id=3                             -> forget it entirely
 *
 * AUTH IS SESSION-ONLY, and this is the sharpest case of that rule in the
 * project — sharper than /api/settings, which only decides how carefully Oscar
 * acts. This endpoint decides WHAT HE CAN DO AT ALL. A POST here can hand the
 * model a tool that did not exist a second ago, pointed at a server of the
 * caller's choosing. The Shortcut key sits in plain text on a phone; it may ask
 * questions, and it may not grow the agent.
 *
 * ADDING A SERVER GRANTS NOTHING BY ITSELF. A new server's tools all arrive at
 * `off` — discovered, listed, described, and withheld from the model until you
 * pick a level for each one. See lib/mcp/servers.js for why that friction is
 * the feature rather than an oversight.
 */

import { getSession } from '../lib/auth.js';
import { applyCors, readBody, send } from '../lib/http.js';
import { isConfigured } from '../lib/db.js';
import { listTools, McpError, MAX_TOOLS } from '../lib/mcp/client.js';
import {
  listServers,
  getServer,
  addServer,
  updateServer,
  deleteServer,
  saveDiscovery,
  publicServer,
  normalizeAccess,
  clearServerCache,
  McpServerError,
  ACCESS_LEVELS,
  ACCESS_DESCRIPTIONS,
  DEFAULT_ACCESS,
  MAX_SERVERS,
} from '../lib/mcp/servers.js';
import { clearSessionCache } from '../lib/mcp/tools.js';
import { clearRemoteTools, isMcpEnabled } from '../lib/tools/index.js';

/**
 * Go and ask a server what it can do, and write down the answer.
 *
 * A failure is stored rather than thrown: `last_error` on the row is what lets
 * the settings page say "this server stopped answering on Tuesday" instead of
 * showing a working server with an empty tool list. The tools it listed last
 * time are deliberately left in place — a server being down for an afternoon is
 * not a reason to lose the access decisions you made about it.
 */
async function discover(row) {
  try {
    const { tools, truncated } = await listTools({ url: row.url, token: row.token });
    const saved = await saveDiscovery(
      row.id,
      {
        tools: tools.map((tool) => ({
          name: String(tool.name || '').slice(0, 120),
          title: tool.title ? String(tool.title).slice(0, 120) : undefined,
          description: tool.description ? String(tool.description).slice(0, 1000) : undefined,
          inputSchema: tool.inputSchema || tool.input_schema || undefined,
          annotations: tool.annotations || undefined,
        })),
        error: truncated
          ? `That server offers more than ${MAX_TOOLS} tools. Only the first ${MAX_TOOLS} were read.`
          : null,
      },
      {}
    );
    return { row: saved, error: null };
  } catch (err) {
    const message = (err && err.message) || 'That server did not answer.';
    try {
      const saved = await updateServer(row.id, { lastError: message, refreshedAt: new Date().toISOString() }, {});
      return { row: saved, error: message };
    } catch {
      return { row, error: message };
    }
  }
}

/** Everything the settings page needs to draw itself, in one reply. */
function payload(rows, extra = {}) {
  return {
    ok: true,
    enabled: isMcpEnabled(),
    storable: isConfigured(),
    hint: isConfigured()
      ? undefined
      : 'No database is configured, so there is nowhere to keep a connected server.',
    servers: rows.map(publicServer),
    accessLevels: ACCESS_LEVELS.map((level) => ({
      level,
      description: ACCESS_DESCRIPTIONS[level],
    })),
    accessDefault: DEFAULT_ACCESS,
    maxServers: MAX_SERVERS,
    ...extra,
  };
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (!getSession(req)) {
    return send(res, 401, { ok: false, error: 'Sign in to manage connected servers.' });
  }

  try {
    if (req.method === 'GET') {
      return send(res, 200, payload(isConfigured() ? await listServers({}) : []));
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url || '/', 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) return send(res, 400, { ok: false, error: 'Which server?' });

      const row = await getServer(id, {});
      await deleteServer(id, {});
      // Both caches, immediately. A removed server whose tools are still in a
      // warm instance's memory would keep working for another half minute,
      // which is exactly the wrong direction for a revocation.
      clearRemoteTools();
      clearSessionCache();
      console.log(`[oscar] disconnected MCP server "${row.label}"`);
      return send(res, 200, payload(await listServers({}), { removed: row.label }));
    }

    if (req.method !== 'POST') {
      return send(res, 405, { ok: false, error: 'Use GET, POST or DELETE.' });
    }

    const body = await readBody(req);

    /* ---- connect a new server ------------------------------------------- */
    if (!body.id) {
      const created = await addServer(
        { label: body.label, url: body.url, token: body.token },
        {}
      );

      // Listed straight away, because "connected" with no tool list tells you
      // nothing about whether the URL and the token were right. The row is
      // already saved either way, so a server that is down can be refreshed
      // later rather than retyped.
      const { row, error } = await discover(created);
      clearRemoteTools();
      console.log(
        `[oscar] connected MCP server "${created.label}" (${(row.tools || []).length} tools)`
      );

      return send(res, 200, payload(await listServers({}), { added: publicServer(row), error }));
    }

    /* ---- change one we already have ------------------------------------- */
    const existing = await getServer(body.id, {});
    let row = existing;
    let error = null;

    if (body.token !== undefined) {
      row = await updateServer(existing.id, { token: body.token }, {});
      // The old credentials may be baked into a live session on this instance.
      clearSessionCache();
    }

    if (body.enabled !== undefined) {
      row = await updateServer(existing.id, { enabled: body.enabled === true }, {});
    }

    if (body.access && typeof body.access === 'object') {
      // Merged onto what is stored, not replacing it, so the page can send one
      // tool at a time as each dropdown changes rather than the whole map.
      const merged = { ...(row.access || {}) };
      const known = new Set((row.tools || []).map((tool) => tool && tool.name));
      for (const [name, level] of Object.entries(body.access)) {
        // A level for a tool this server does not offer is dropped rather than
        // stored: it could only ever be stale UI or a typo, and keeping it
        // would mean a permission sitting in the database waiting for a tool of
        // that name to appear.
        if (!known.has(name)) continue;
        merged[name] = normalizeAccess(level);
      }
      row = await updateServer(existing.id, { access: merged }, {});
      console.log(`[oscar] MCP access changed on "${row.label}"`);
    }

    if (body.refresh === true) {
      const outcome = await discover(row);
      row = outcome.row;
      error = outcome.error;
    }

    // Any of the above changes what the model may hold, so the in-process tool
    // list is dropped rather than left to age out.
    clearServerCache();
    clearRemoteTools();

    return send(res, 200, payload(await listServers({}), { saved: publicServer(row), error }));
  } catch (err) {
    const known = err instanceof McpServerError || err instanceof McpError;
    const status = err instanceof McpServerError ? err.status : known ? 400 : 500;
    if (!known) console.error('[oscar] mcp:', err);
    return send(res, status, {
      ok: false,
      error: known ? err.message : 'That request failed.',
    });
  }
}
