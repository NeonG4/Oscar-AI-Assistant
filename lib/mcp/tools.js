/**
 * lib/mcp/tools.js
 * ----------------------------------------------------------------------------
 * Turning somebody else's MCP server into tools Oscar can hold.
 *
 * A tool in this project is `{ name, description, parameters, run }` and a few
 * flags — see the top of lib/tools/index.js. An MCP tool is name, description
 * and a JSON Schema. The two are almost the same shape, which is the reason
 * this feature is small: the adapter below is mostly renaming, and the
 * interesting parts are the three things MCP does not give us.
 *
 *   1. PERMISSION. Nothing in a tools/list response says whether a tool is safe.
 *      The annotations that claim to are written by the server being gated, so
 *      they are shown to you and used for nothing. What decides is the per-tool
 *      access level you set, stored beside the server. See lib/mcp/servers.js.
 *
 *   2. TRUST IN THE OUTPUT. Every built-in tool's result was produced by code in
 *      this repository talking to an API chosen by this repository. A remote
 *      result is text of somebody else's choosing, arriving in the context of a
 *      model that can send mail as you and run commands on your laptop. So it
 *      is labelled with the server it came from, and the system prompt says
 *      plainly that such text is data and never instructions. The confirm gate
 *      is what actually contains it — which is the other reason `ask` is the
 *      level to reach for.
 *
 *   3. A BUDGET. A built-in tool has a timeout its author picked. A remote one
 *      has whatever the server feels like, inside a 60-second function that is
 *      also paying for the model. Hence CALL_TIMEOUT_MS.
 */

import { callTool, connect, McpError, TIMEOUT_MS } from './client.js';
import {
  loadEnabledServers,
  normalizeAccessMap,
  prefixedName,
  DEFAULT_ACCESS,
} from './servers.js';

/**
 * How long one remote tool call may take.
 *
 * Shorter than the client's own default because the caller here is an agent
 * round inside a function with a 60-second ceiling, and a server that has not
 * answered in ten seconds has already cost more than the answer is worth. The
 * model is told it timed out and can try something else, which is a much better
 * outcome than the whole request dying.
 */
export const CALL_TIMEOUT_MS = 10000;

/** How much of a remote result the model is shown. Same cap as run_cmd output. */
export const MAX_RESULT_CHARS = 4000;

/* ------------------------------------------------------------------ schemas */

/**
 * A JSON Schema we are willing to put in front of the model.
 *
 * Two jobs. The obvious one is shape: OpenAI wants an object schema, and a
 * server that sends `null`, a string, or a bare `{}` should produce a tool that
 * takes no arguments rather than a 400 that kills the whole request — one bad
 * server must not be able to break every question you ask.
 *
 * The less obvious one is size. This schema is re-sent on every model call for
 * the life of the run, so a pathological one is not a one-off cost, it is a tax
 * on every round. Depth and breadth are both capped, and a schema that hits
 * either is trimmed rather than rejected: a tool with some of its optional
 * arguments missing still works, and a tool that was dropped does not.
 */
export function sanitizeSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }

  // Deeper than this and we are describing a data structure, not an argument
  // list. `{}` at the leaf means "any value", which is honest about what we
  // stopped describing.
  if (depth > 6) return {};

  const out = {};
  const KEEP = [
    'type',
    'description',
    'enum',
    'const',
    'format',
    'default',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'pattern',
    'required',
  ];

  for (const key of KEEP) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }

  // Handled apart from the list above because it is the one keyword that can be
  // either a boolean or a whole schema — and passing the schema form through
  // untouched would be a hole straight around the depth cap.
  if (typeof schema.additionalProperties === 'boolean') {
    out.additionalProperties = schema.additionalProperties;
  } else if (schema.additionalProperties) {
    out.additionalProperties = sanitizeSchema(schema.additionalProperties, depth + 1);
  }

  if (typeof out.description === 'string') out.description = out.description.slice(0, 400);
  if (Array.isArray(out.enum)) out.enum = out.enum.slice(0, 40);
  if (Array.isArray(out.required)) out.required = out.required.slice(0, 40).map(String);

  if (schema.properties && typeof schema.properties === 'object') {
    const properties = {};
    let count = 0;
    for (const [name, value] of Object.entries(schema.properties)) {
      if (count >= 40) break;
      properties[String(name).slice(0, 64)] = sanitizeSchema(value, depth + 1);
      count += 1;
    }
    out.properties = properties;
  }

  if (schema.items) out.items = sanitizeSchema(schema.items, depth + 1);

  // A top-level schema has to be an object for the API to accept it at all.
  if (depth === 0) {
    out.type = 'object';
    if (!out.properties) out.properties = {};
  }

  return out;
}

/* -------------------------------------------------------------- descriptions */

/**
 * What the model is told about a remote tool.
 *
 * The server's own description, plus which server it belongs to. That last part
 * is not decoration: with three servers connected there may well be two tools
 * called `search`, and "search on Linear" is the difference between the model
 * picking the right one and picking a coin flip.
 */
export function describeRemoteTool(row, tool) {
  const own = String((tool && (tool.description || tool.title)) || '').replace(/\s+/g, ' ').trim();
  const label = row.label || row.slug;
  const base = own ? own.slice(0, 700) : `The "${tool.name}" tool.`;
  return `${base} (from your connected ${label} server)`;
}

/* -------------------------------------------------------------- the sessions */

/**
 * Sessions, remembered for as long as this process lives.
 *
 * An MCP call is two round trips if you handshake first, and one if you already
 * have a session id. On a warm function that difference is most of the latency
 * of a remote tool call, so the id is kept — keyed by server id, dropped the
 * moment a call fails in a way that suggests the server has forgotten us.
 *
 * This is per-instance and unshared, exactly like the caches in lib/settings.js,
 * and for the same reason: it holds a performance hint, never a permission.
 */
const sessions = new Map();

export function clearSessionCache() {
  sessions.clear();
}

function looksLikeStaleSession(err) {
  const message = String((err && err.message) || '').toLowerCase();
  return (
    (err && (err.status === 404 || err.status === 400)) ||
    message.includes('session') ||
    message.includes('not initialized')
  );
}

/**
 * Call a remote tool, handshaking if needed and once more if the session went
 * stale underneath us.
 *
 * The retry is the whole reason this is not a direct call to the client: a
 * serverless instance can sit warm for an hour holding a session id the server
 * expired forty minutes ago, and "your tool broke" would be a lie about a
 * problem we can fix by saying hello again.
 */
export async function callRemote(row, toolName, args, deps = {}) {
  const base = { url: row.url, token: row.token };
  const options = { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs || CALL_TIMEOUT_MS };

  let session = sessions.get(row.id);
  if (!session) {
    session = await connect(base, options);
    sessions.set(row.id, session);
  }

  try {
    return await callTool({ ...base, ...session }, toolName, args, options);
  } catch (err) {
    if (!looksLikeStaleSession(err)) throw err;
    sessions.delete(row.id);
    const fresh = await connect(base, options);
    sessions.set(row.id, fresh);
    return callTool({ ...base, ...fresh }, toolName, args, options);
  }
}

/* ---------------------------------------------------------------- the adapter */

function shorten(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  return s.length <= MAX_RESULT_CHARS ? s : `${s.slice(0, MAX_RESULT_CHARS)}\n... [truncated]`;
}

/**
 * One stored server plus one of its tools, as a tool Oscar can hold.
 *
 * The flags are derived from the access level and nothing else:
 *
 *   read  ->  writes: false, confirm: false   offered to everything
 *   ask   ->  writes: true,  confirm: true    write authority, read back first
 *   open  ->  writes: true,  confirm: false   write authority, acts immediately
 *
 * `off` never reaches here — loadMcpTools filters it out, so a withheld tool is
 * absent from the list rather than present and refusing, and the model is never
 * told it exists.
 */
export function toOscarTool(row, tool, access = DEFAULT_ACCESS) {
  const name = prefixedName(row.slug, tool.name);
  const label = row.label || row.slug;

  return {
    name,
    description: describeRemoteTool(row, tool),
    parameters: sanitizeSchema(tool.inputSchema || tool.input_schema),

    // See the doc comment. Everything but `read` costs write authority.
    writes: access !== 'read',
    confirm: access === 'ask',

    // Marks this as not one of ours. lib/tools/index.js uses it to keep remote
    // tools out of the built-in gates (Google, Supabase, the runner), and
    // api/health.js uses it to report them separately.
    remote: {
      serverId: row.id,
      server: label,
      slug: row.slug,
      tool: tool.name,
      access,
      // What the server SAYS about itself. Recorded so the settings page can
      // show it. Never consulted when deciding anything — see lib/mcp/servers.js.
      annotations: tool.annotations || null,
    },

    /**
     * What the confirmation card says. Deliberately names the server as well as
     * the tool: "Run delete_issue on Linear?" is a question you can answer, and
     * "Go ahead with linear__delete_issue?" is not.
     */
    describe(args) {
      const shown = JSON.stringify(args || {});
      const detail = shown.length > 300 ? `${shown.slice(0, 300)}…` : shown;
      return `Run "${tool.name}" on your ${label} server with ${detail}?`;
    },

    /**
     * Failures THROW here rather than returning an `{ error }` field, which is
     * the convention every built-in tool follows: runTool catches it and hands
     * the message to the model as the tool's result, so a server that is down
     * costs you a sentence in the answer rather than the whole run. Returning
     * the error instead would bury it inside a successful-looking result, where
     * the model reads it as data it just fetched.
     */
    async run(args, ctx = {}) {
      let outcome;
      try {
        outcome = await callRemote(row, tool.name, args, {
          fetchImpl: ctx.fetchImpl,
          timeoutMs: ctx.mcpTimeoutMs,
        });
      } catch (err) {
        const message = (err && err.message) || 'That server did not answer.';
        // Named, always. "Could not reach it" is a much less useful thing for
        // the model to say than "your Linear server did not answer".
        throw new Error(
          err instanceof McpError
            ? `Your ${label} server: ${message}`
            : `Could not run that on ${label}: ${message}`
        );
      }

      const text = shorten(outcome.text);

      // The tool ran and reported failure — different from the call failing,
      // and the model should get the server's own words for it.
      if (outcome.isError) {
        throw new Error(text || `The ${label} server could not complete that.`);
      }

      return {
        // Which server this came from, on every result. The model needs it to
        // attribute what it says, and the system prompt leans on it when it
        // tells the model that remote text is data rather than instructions.
        server: label,
        output: text || '(the tool returned nothing)',
      };
    },
  };
}

/* ----------------------------------------------------------------- the load */

/**
 * Every remote tool currently available, as Oscar tool definitions.
 *
 * Never throws and never rejects: a server that is down, a row that is
 * malformed, a database that timed out — all of them mean you get the built-in
 * tools and no extras, which is the same rule lib/db.js follows for logging. An
 * expansion mechanism that can take down the thing it expands is worse than not
 * having it.
 */
export async function loadMcpTools(deps = {}) {
  const rows = await loadEnabledServers(deps);
  const tools = [];

  for (const row of rows) {
    const access = normalizeAccessMap(row.access);
    const listed = Array.isArray(row.tools) ? row.tools : [];

    for (const tool of listed) {
      if (!tool || !tool.name) continue;
      const level = access[tool.name] || DEFAULT_ACCESS;
      if (level === 'off') continue;
      try {
        tools.push(toOscarTool(row, tool, level));
      } catch (err) {
        console.error(
          `[oscar] could not adapt ${row.slug}/${tool.name}: ${(err && err.message) || err}`
        );
      }
    }
  }

  return tools;
}

export { TIMEOUT_MS as MCP_TIMEOUT_MS };
