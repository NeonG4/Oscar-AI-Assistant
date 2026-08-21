/**
 * lib/osint.js
 * ----------------------------------------------------------------------------
 * Looking someone up from what they published themselves.
 *
 *   "who is torvalds"
 *      → sweepUsername()  — which public sites have that handle
 *      → the profile each of those sites publishes
 *      → and, if a profile links a personal domain, who registered it
 *
 * All of it is public: the same pages anyone can open in a browser, fetched
 * through the sites' own documented, keyless APIs. Nothing here logs in,
 * nothing here reads a page that asks you to log in, and nothing here touches
 * breach dumps. See OSINT.md for the boundary and why it is drawn there.
 *
 * THE ONE DESIGN DECISION THAT MATTERS: THREE STATES, NOT TWO
 *
 * The obvious way to check a handle is to fetch the profile URL and call 200
 * "taken" and 404 "free". It is also wrong, and wrong in the direction that
 * produces confident lies. Measured against real endpoints, from a server:
 *
 *   - pypi.org returns 200 and a bot-check page ("Client Challenge") for BOTH a
 *     real user and a nonsense one. Status-only logic reports every username on
 *     earth as a PyPI user.
 *   - reddit.com returns 403 to datacenter IPs whoever you ask about, so a
 *     "not found" there means "Reddit would not talk to us", not "nobody".
 *   - t.me serves a full 200 page for handles that do not exist.
 *
 * So every probe resolves to `found`, `absent`, or `unknown`, and `unknown` is
 * a first-class answer that the tool reports rather than hides. A site whose
 * two cases could not be told apart is not in the catalogue at all; a site that
 * blocks servers outright is listed as `blocked` with its human URL, never
 * probed. Every entry in SITES below was checked against a real account and a
 * nonsense one before it was allowed in.
 *
 * A false "found" is worse than a shrug. Someone asks who a handle belongs to,
 * and the answer becomes part of what they believe about a person.
 *
 * BUILDING URLS OUT OF SOMEONE ELSE'S STRING. The username arrives from speech
 * or from a model and gets interpolated into URLs we then fetch server-side,
 * which is the shape of an SSRF if you let it be. normalizeUsername() is the
 * gate: a strict allow-list of characters, a length cap, and every use is
 * encodeURIComponent'd anyway. Belt and braces, because only one of the two has
 * to hold for the request to stay on the host we intended.
 */

const TIMEOUT_MS = 6000;
const SWEEP_BUDGET_MS = 20000;
const CONCURRENCY = 6;

/** Usernames are letters, digits, dot, underscore, hyphen. Nothing else, ever. */
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export class OsintError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OsintError';
  }
}

/* ------------------------------------------------------------------ helpers */

/** Identify ourselves. Several of these APIs ask for it, and it is only polite. */
export function userAgent(env = process.env) {
  const contact = (env.OSCAR_OWNER_EMAIL || '').trim();
  return contact ? `Oscar-Assistant/1.0 (${contact})` : 'Oscar-Assistant/1.0';
}

/** Drop nulls, blanks and empty arrays. A profile is mostly empty fields. */
export function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

/**
 * Bios come back as HTML on Mastodon, Hacker News and Lobsters. The model does
 * not need the markup and it costs tokens, so flatten it to text.
 */
export function stripHtml(html, limit = 400) {
  if (typeof html !== 'string') return null;
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Unix seconds → a plain date. Half these APIs report time this way. */
export function isoDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e11 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** Trim an ISO timestamp to the date. When someone joined is the useful part. */
export function justDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Accept what a person would actually say or paste.
 *
 * "@jack" → "jack". "github.com/torvalds" → "torvalds". Then the allow-list:
 * anything with a slash, colon, percent or space left in it after that is not a
 * username, and we refuse rather than guessing what was meant.
 */
export function normalizeUsername(raw) {
  let value = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!value) throw new OsintError('I need a username to look up.');

  // A pasted profile URL: take the last meaningful path segment.
  if (/^https?:\/\//i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(value)) {
    const parts = value.replace(/^https?:\/\//i, '').split('/').filter(Boolean);
    value = parts.length > 1 ? parts[parts.length - 1] : value;
  }

  value = value.replace(/^[@~]+/, '').replace(/\/+$/, '').trim();

  if (!value) throw new OsintError('I need a username to look up.');
  if (!USERNAME_RE.test(value)) {
    throw new OsintError(
      `"${String(raw).slice(0, 60)}" does not look like a username. ` +
        'Usernames here are letters, digits, dots, underscores and hyphens, up to 40 characters.'
    );
  }
  return value;
}

export function normalizeDomain(raw) {
  let value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!value) throw new OsintError('I need a domain name to look up.');
  value = value
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .split('@')
    .pop()
    .replace(/\.$/, '')
    .trim();
  if (!DOMAIN_RE.test(value)) {
    throw new OsintError(`"${String(raw).slice(0, 60)}" does not look like a domain name.`);
  }
  return value;
}

/**
 * One HTTP GET, with a deadline.
 *
 * Never throws: a probe that blew up is a probe whose answer is "unknown", and
 * the sweep must survive one site being down. Returns the parsed JSON when the
 * body parses, and the raw text either way.
 */
async function getOnce(url, { doFetch, headers = {}, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: controller.signal, headers, redirect: 'follow' });
    const text = typeof res.text === 'function' ? await res.text() : '';
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok !== false, status: Number(res.status) || 0, text, json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: '',
      json: null,
      failure: err && err.name === 'AbortError' ? 'timed out' : 'could not be reached',
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------------- catalogue */

/**
 * Sites we probe. Every one was verified against a real account and a nonsense
 * one; `found` and `absent` below describe what was actually observed, not what
 * the documentation promises.
 *
 *   id        stable key the model passes to lookup_profile
 *   probe     the URL we fetch (the API, not the human page)
 *   profile   the URL a person would open
 *   decide    ({status, json, text}) → 'found' | 'absent' | 'unknown'
 *   summarize (json) → the fields worth reporting
 */
export const SITES = [
  {
    id: 'github',
    label: 'GitHub',
    probe: (u) => `https://api.github.com/users/${encodeURIComponent(u)}`,
    profile: (u) => `https://github.com/${encodeURIComponent(u)}`,
    headers: (env) => {
      const token = (env.OSCAR_GITHUB_TOKEN || '').trim();
      return {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
    },
    decide: ({ status }) => {
      if (status === 200) return 'found';
      if (status === 404) return 'absent';
      // 403/429 here is the unauthenticated 60-per-hour limit, shared across
      // everything running on this deployment's IP. Saying "no GitHub account"
      // because we ran out of budget would be a lie, so say we do not know.
      if (status === 403 || status === 429) {
        return { state: 'unknown', reason: 'GitHub rate-limited this lookup' };
      }
      return 'unknown';
    },
    summarize: (j) =>
      compact({
        displayName: j.name,
        bio: j.bio,
        company: j.company,
        location: j.location,
        website: j.blog,
        twitter: j.twitter_username,
        accountType: j.type && j.type !== 'User' ? j.type : null,
        publicRepos: j.public_repos,
        followers: j.followers,
        joined: justDate(j.created_at),
      }),
    // Only lookup_profile pays for this second request. What someone has
    // pushed to lately says more about who they are than a follower count.
    detail: async (u, deps) => {
      const res = await getOnce(
        `https://api.github.com/users/${encodeURIComponent(u)}/repos?sort=pushed&per_page=5`,
        {
          doFetch: deps.fetchImpl || globalThis.fetch,
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': userAgent(deps.env || process.env),
          },
          timeoutMs: deps.timeoutMs || TIMEOUT_MS,
        }
      );
      if (res.status !== 200 || !Array.isArray(res.json)) return null;
      return {
        recentRepos: res.json.map((r) =>
          compact({
            name: r.name,
            description: r.description,
            language: r.language,
            stars: r.stargazers_count,
            lastPush: justDate(r.pushed_at),
            fork: r.fork ? true : null,
          })
        ),
      };
    },
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    probe: (u) => `https://gitlab.com/api/v4/users?username=${encodeURIComponent(u)}`,
    profile: (u) => `https://gitlab.com/${encodeURIComponent(u)}`,
    // Always 200. An empty array is the "no such user" signal.
    decide: ({ status, json }) => {
      if (status !== 200 || !Array.isArray(json)) return 'unknown';
      return json.length > 0 ? 'found' : 'absent';
    },
    summarize: (j) => {
      const user = Array.isArray(j) ? j[0] : j;
      if (!user) return {};
      return compact({
        displayName: user.name,
        state: user.state,
        profileUrl: user.web_url,
      });
    },
  },
  {
    id: 'hackernews',
    label: 'Hacker News',
    // Case-sensitive: "pg" and "PG" are different people here.
    probe: (u) => `https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(u)}.json`,
    profile: (u) => `https://news.ycombinator.com/user?id=${encodeURIComponent(u)}`,
    caseSensitive: true,
    // Firebase answers 200 with the literal body `null` for a missing user.
    decide: ({ status, json, text }) => {
      if (status !== 200) return 'unknown';
      if (json === null || String(text).trim() === 'null') return 'absent';
      return 'found';
    },
    summarize: (j) =>
      compact({
        karma: j.karma,
        joined: isoDate(j.created),
        about: stripHtml(j.about),
        submissions: Array.isArray(j.submitted) ? j.submitted.length : null,
      }),
  },
  {
    id: 'keybase',
    label: 'Keybase',
    // The single most useful stop: Keybase proofs are cross-site identity links
    // the person published and signed themselves.
    probe: (u) =>
      `https://keybase.io/_/api/1.0/user/lookup.json?username=${encodeURIComponent(u)}` +
      '&fields=basics,profile,proofs_summary',
    profile: (u) => `https://keybase.io/${encodeURIComponent(u)}`,
    // Always 200; the verdict is in status.code. 0 = found, 205 = no such user,
    // 100 = the name could never be a Keybase name (too long, bad character).
    decide: ({ status, json }) => {
      if (status !== 200 || !json || !json.status) return 'unknown';
      const code = Number(json.status.code);
      if (code === 0) return 'found';
      if (code === 205) return 'absent';
      if (code === 100) return { state: 'absent', reason: 'not a valid Keybase username' };
      return 'unknown';
    },
    summarize: (j) => {
      const them = j.them || {};
      const profile = them.profile || {};
      const proofs = ((them.proofs_summary || {}).all || []).map((p) =>
        compact({ service: p.proof_type, name: p.nametag, url: p.service_url })
      );
      return compact({
        fullName: profile.full_name,
        location: profile.location,
        bio: stripHtml(profile.bio),
        joined: isoDate((them.basics || {}).ctime),
        // The payoff: "this handle is also that handle, and they proved it."
        provenAccounts: proofs,
      });
    },
  },
  {
    id: 'mastodon',
    label: 'Mastodon (mastodon.social)',
    // One instance out of thousands. Absent here means absent from this server,
    // which is why the tool result says so in as many words.
    probe: (u) => `https://mastodon.social/api/v1/accounts/lookup?acct=${encodeURIComponent(u)}`,
    profile: (u) => `https://mastodon.social/@${encodeURIComponent(u)}`,
    scope: 'mastodon.social only — Mastodon has thousands of other servers',
    summarize: (j) =>
      compact({
        displayName: j.display_name,
        bio: stripHtml(j.note),
        followers: j.followers_count,
        posts: j.statuses_count,
        joined: justDate(j.created_at),
        profileUrl: j.url,
        // Profile metadata rows. A green tick on one means the linked site
        // links back, which is a real verification and worth surfacing.
        links: (j.fields || [])
          .map((f) =>
            compact({
              label: f.name,
              value: stripHtml(f.value, 120),
              verified: Boolean(f.verified_at),
            })
          )
          .filter((f) => f.value),
      }),
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    probe: (u) =>
      'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=' +
      encodeURIComponent(`${u}.bsky.social`),
    profile: (u) => `https://bsky.app/profile/${encodeURIComponent(u)}.bsky.social`,
    scope: 'the default handle only — a custom-domain handle would not be seen',
    // Missing profiles come back 400 InvalidRequest, not 404.
    decide: ({ status, json }) => {
      if (status === 200) return 'found';
      if (status === 400 && json && /not found/i.test(String(json.message || ''))) return 'absent';
      if (status === 404) return 'absent';
      return 'unknown';
    },
    summarize: (j) =>
      compact({
        displayName: j.displayName,
        handle: j.handle,
        bio: stripHtml(j.description),
        followers: j.followersCount,
        posts: j.postsCount,
        joined: justDate(j.createdAt),
      }),
  },
  {
    id: 'lobsters',
    label: 'Lobsters',
    probe: (u) => `https://lobste.rs/~${encodeURIComponent(u)}.json`,
    profile: (u) => `https://lobste.rs/~${encodeURIComponent(u)}`,
    summarize: (j) =>
      compact({
        joined: justDate(j.created_at),
        karma: j.karma,
        about: stripHtml(j.about),
        github: j.github_username,
        twitter: j.twitter_username,
        moderator: j.is_moderator || j.is_admin ? true : null,
        invitedBy: j.invited_by_user,
      }),
  },
  {
    id: 'devto',
    label: 'DEV Community',
    probe: (u) => `https://dev.to/api/users/by_username?url=${encodeURIComponent(u)}`,
    profile: (u) => `https://dev.to/${encodeURIComponent(u)}`,
    summarize: (j) =>
      compact({
        displayName: j.name,
        bio: stripHtml(j.summary),
        location: j.location,
        website: j.website_url,
        twitter: j.twitter_username,
        github: j.github_username,
        joined: j.joined_at,
      }),
  },
  {
    id: 'dockerhub',
    label: 'Docker Hub',
    probe: (u) => `https://hub.docker.com/v2/users/${encodeURIComponent(u)}/`,
    profile: (u) => `https://hub.docker.com/u/${encodeURIComponent(u)}`,
    summarize: (j) =>
      compact({
        displayName: j.full_name,
        location: j.location,
        company: j.company,
        website: j.profile_url,
        joined: justDate(j.date_joined),
      }),
  },
  {
    id: 'chess',
    label: 'Chess.com',
    probe: (u) => `https://api.chess.com/pub/player/${encodeURIComponent(u)}`,
    profile: (u) => `https://www.chess.com/member/${encodeURIComponent(u)}`,
    summarize: (j) =>
      compact({
        displayName: j.name,
        title: j.title,
        country: j.country ? String(j.country).split('/').pop() : null,
        location: j.location,
        followers: j.followers,
        joined: isoDate(j.joined),
        lastOnline: isoDate(j.last_online),
        status: j.status,
      }),
  },
  {
    id: 'npm',
    label: 'npm',
    // There is no keyless endpoint for "does this npm account exist" any more —
    // the user document went behind auth. What is still public is the package
    // search, so this answers a narrower question: has this name PUBLISHED
    // anything? Nothing found therefore cannot mean "no account", and this is
    // the one site in the catalogue whose negative is reported as `unknown`.
    probe: (u) =>
      `https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(u)}&size=5`,
    profile: (u) => `https://www.npmjs.com/~${encodeURIComponent(u)}`,
    decide: ({ status, json }) => {
      if (status !== 200 || !json || !Array.isArray(json.objects)) return 'unknown';
      if (json.objects.length > 0) return 'found';
      return { state: 'unknown', reason: 'no published packages — an account may still exist' };
    },
    summarize: (j) => {
      const objects = Array.isArray(j.objects) ? j.objects : [];
      return compact({
        publishedPackages: j.total,
        examples: objects.slice(0, 5).map((o) => (o.package || {}).name).filter(Boolean),
      });
    },
  },
];

/**
 * Sites a person would want checked that we refuse to guess at.
 *
 * Each of these either blocks datacenter IPs, demands a login, or answers 200
 * to everything — so any verdict we produced would be noise wearing a suit. We
 * name them and hand over the URL instead, which is the honest version of the
 * same help.
 */
export const BLOCKED_SITES = [
  {
    id: 'reddit',
    label: 'Reddit',
    profile: (u) => `https://www.reddit.com/user/${encodeURIComponent(u)}`,
    why: 'blocks server requests (HTTP 403) whoever is asked about',
  },
  {
    id: 'pypi',
    label: 'PyPI',
    profile: (u) => `https://pypi.org/user/${encodeURIComponent(u)}/`,
    why: 'answers every request with a bot check, so real and fake look identical',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    profile: (u) => `https://www.instagram.com/${encodeURIComponent(u)}/`,
    why: 'requires a login',
  },
  {
    id: 'x',
    label: 'X / Twitter',
    profile: (u) => `https://x.com/${encodeURIComponent(u)}`,
    why: 'requires a login',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    profile: (u) => `https://www.tiktok.com/@${encodeURIComponent(u)}`,
    why: 'blocks server requests',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    profile: (u) => `https://www.linkedin.com/in/${encodeURIComponent(u)}`,
    why: 'requires a login, and its terms forbid automated access',
  },
  {
    id: 'facebook',
    label: 'Facebook',
    profile: (u) => `https://www.facebook.com/${encodeURIComponent(u)}`,
    why: 'requires a login',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    profile: (u) => `https://t.me/${encodeURIComponent(u)}`,
    why: 'serves a normal page for handles that do not exist',
  },
];

const BY_ID = new Map(SITES.map((s) => [s.id, s]));

export function getSite(id) {
  return BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

export function siteIds() {
  return SITES.map((s) => s.id);
}

/* --------------------------------------------------------------------- probe */

/** Normalise whatever `decide` returned into { state, reason }. */
function readVerdict(verdict) {
  if (typeof verdict === 'string') return { state: verdict, reason: null };
  if (verdict && typeof verdict === 'object' && verdict.state) {
    return { state: verdict.state, reason: verdict.reason || null };
  }
  return { state: 'unknown', reason: null };
}

/** The default when a site does not supply its own `decide`. */
function defaultDecide({ status }) {
  if (status === 200) return 'found';
  if (status === 404) return 'absent';
  if (status === 403 || status === 429) {
    return { state: 'unknown', reason: 'the site declined the request' };
  }
  return 'unknown';
}

/**
 * Ask one site about one username.
 *
 * Resolves to { site, label, url, state, reason?, profile? } and never rejects.
 */
export async function probeSite(site, username, deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const headers = {
    accept: 'application/json',
    'user-agent': userAgent(env),
    ...(typeof site.headers === 'function' ? site.headers(env) : {}),
  };

  const res = await getOnce(site.probe(username), {
    doFetch,
    headers,
    timeoutMs: deps.timeoutMs || TIMEOUT_MS,
  });

  const base = { site: site.id, label: site.label, url: site.profile(username) };
  if (site.scope) base.scope = site.scope;

  if (res.failure) return { ...base, state: 'unknown', reason: `the site ${res.failure}` };

  const { state, reason } = readVerdict((site.decide || defaultDecide)(res));
  const out = { ...base, state };
  if (reason) out.reason = reason;
  if (state === 'unknown' && !reason) out.reason = `unexpected response (HTTP ${res.status})`;

  if (state === 'found' && site.summarize && res.json) {
    try {
      const profile = site.summarize(res.json);
      if (profile && Object.keys(profile).length) out.profile = profile;
    } catch {
      // A summariser tripping over an unexpected shape must not turn a correct
      // "found" into a failure. The hit still stands; it just arrives bare.
    }
  }
  return out;
}

/**
 * One site, asked properly — the read step after the sweep's search step.
 *
 * Same probe, plus whatever `detail` the site defines. Kept separate because
 * asking eleven sites to answer "what is his GitHub bio" is eleven times the
 * requests for one eleventh of the answer.
 */
export async function fetchProfile(siteId, rawUsername, deps = {}) {
  const site = getSite(siteId);
  if (!site) {
    throw new OsintError(
      `I cannot look up "${String(siteId).slice(0, 40)}". I know: ${siteIds().join(', ')}.`
    );
  }
  const username = normalizeUsername(rawUsername);
  const result = await probeSite(site, username, deps);

  if (result.state === 'found' && typeof site.detail === 'function') {
    try {
      const extra = await site.detail(username, deps);
      if (extra) Object.assign(result, extra);
    } catch {
      // Depth is a bonus. Losing it must not lose the profile we already have.
    }
  }
  return result;
}

/** Run tasks with a cap on how many are in flight, and an overall deadline. */
async function pool(items, limit, deadline, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      if (Date.now() > deadline) {
        results[index] = null;
        continue;
      }
      results[index] = { value: await worker(items[index]) };
    }
  });
  await Promise.all(runners);
  return results;
}

/** found first, then unknown, then absent — the model reads the top of a list. */
const ORDER = { found: 0, unknown: 1, absent: 2 };

/**
 * Check a username across the catalogue.
 *
 * @param {string} rawUsername
 * @param {{sites?: string[]}} [options]
 */
export async function sweepUsername(rawUsername, options = {}, deps = {}) {
  const username = normalizeUsername(rawUsername);

  let targets = SITES;
  if (Array.isArray(options.sites) && options.sites.length) {
    const wanted = new Set(options.sites.map((s) => String(s).trim().toLowerCase()));
    targets = SITES.filter((s) => wanted.has(s.id));
    if (!targets.length) {
      throw new OsintError(
        `I do not check any site called that. I can check: ${siteIds().join(', ')}.`
      );
    }
  }

  const deadline = Date.now() + (deps.budgetMs || SWEEP_BUDGET_MS);
  const settled = await pool(targets, deps.concurrency || CONCURRENCY, deadline, (site) =>
    probeSite(site, username, deps)
  );

  const results = settled.map((entry, i) =>
    entry && entry.value
      ? entry.value
      : {
          site: targets[i].id,
          label: targets[i].label,
          url: targets[i].profile(username),
          state: 'unknown',
          reason: 'ran out of time before this site was checked',
        }
  );

  results.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.site.localeCompare(b.site));

  const found = results.filter((r) => r.state === 'found');
  const unknown = results.filter((r) => r.state === 'unknown');

  return {
    username,
    found,
    unknown,
    absent: results.filter((r) => r.state === 'absent').map((r) => r.site),
    // Handed over rather than guessed at — see BLOCKED_SITES.
    notChecked: BLOCKED_SITES.map((s) => ({
      site: s.id,
      label: s.label,
      url: s.profile(username),
      why: s.why,
    })),
    summary:
      `${found.length} of ${results.length} checked sites have this handle` +
      (unknown.length ? `, ${unknown.length} could not be determined` : '') +
      '. A handle matching does not prove it is the same person.',
  };
}

/* ---------------------------------------------------------------------- rdap */

const RDAP_URL = 'https://rdap.org/domain/';

/**
 * Who registered a domain, over RDAP — the IETF replacement for WHOIS.
 *
 * rdap.org is a bootstrap redirector: it looks at the TLD and forwards to that
 * registry's own server, so one URL covers every domain without a key. Since
 * GDPR most registrant fields come back redacted, and that is worth reporting
 * as a fact about the record rather than passing back an empty object — the
 * dates and the registrar survive, and those are usually the useful part.
 */
export async function lookupDomain(rawDomain, deps = {}) {
  const domain = normalizeDomain(rawDomain);
  const env = deps.env || process.env;
  const doFetch = deps.fetchImpl || globalThis.fetch;

  const res = await getOnce(`${RDAP_URL}${encodeURIComponent(domain)}`, {
    doFetch,
    headers: { accept: 'application/rdap+json, application/json', 'user-agent': userAgent(env) },
    timeoutMs: deps.timeoutMs || TIMEOUT_MS,
  });

  if (res.failure) throw new OsintError(`The domain registry ${res.failure}.`);
  if (res.status === 404) return { domain, registered: false };
  if (res.status !== 200 || !res.json) {
    throw new OsintError(`The domain registry returned an error (HTTP ${res.status}).`);
  }

  const data = res.json;
  const events = {};
  for (const event of data.events || []) {
    if (event && event.eventAction) events[event.eventAction] = justDate(event.eventDate);
  }

  // The registrar is an entity with the "registrar" role; its name lives in a
  // jCard, which is an array-of-arrays format that is no fun to walk.
  let registrar = null;
  const contacts = [];
  for (const entity of data.entities || []) {
    const roles = entity.roles || [];
    const card = Array.isArray(entity.vcardArray) ? entity.vcardArray[1] || [] : [];
    const fn = (card.find((row) => row && row[0] === 'fn') || [])[3];
    if (roles.includes('registrar') && fn) registrar = fn;
    else if (fn) contacts.push({ role: roles.join(', ') || 'contact', name: fn });
  }

  return compact({
    domain,
    registered: true,
    registrar,
    status: (data.status || []).join(', '),
    created: events.registration,
    updated: events['last changed'] || events['last update of RDAP database'],
    expires: events.expiration,
    nameservers: (data.nameservers || []).map((n) => n.ldhName).filter(Boolean),
    contacts,
    note: contacts.length
      ? null
      : 'Registrant details are redacted, which is the norm since GDPR — not a sign of concealment.',
  });
}
