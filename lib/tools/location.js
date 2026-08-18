/**
 * lib/tools/location.js
 * ----------------------------------------------------------------------------
 * "Where am I?" and "where is X?"
 *
 * Four ways to get coordinates, tried in this order of trustworthiness:
 *
 *   1. A place name in the question   — "weather in Tokyo" → geocode it
 *   2. GPS from the Shortcut          — exact, if the Shortcut sends lat/lon
 *   3. The caller's IP address        — city-level, often wrong on cellular/VPN
 *   4. OSCAR_HOME_LOCATION            — your configured fallback
 *
 * Services used, both free and keyless:
 *   - Open-Meteo Geocoding  (name → coordinates)
 *   - ipapi.co              (IP → approximate coordinates)
 *   - Nominatim / OSM       (coordinates → city name)
 *
 * A NOTE ON THE ONE THAT ISN'T HERE. The obvious pick for coordinates → city is
 * BigDataCloud's `reverse-geocode-client`, which is free and keyless. Its fair
 * use policy explicitly forbids server-side calls, and breaching it returns
 * HTTP 402 and can get your IP banned. Since every call here comes from a Vercel
 * function, that endpoint is off limits. Nominatim permits server-side use at
 * low volume provided you send an identifying User-Agent, which we do.
 *
 * Reverse geocoding is strictly a nicety — it turns "47.61, -122.33" into
 * "Seattle" so answers read better. Every failure here degrades to "your
 * location" rather than breaking the request.
 */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const IP_LOOKUP_URL = 'https://ipapi.co';
const REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

const TIMEOUT_MS = 4000;

export class LocationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocationError';
  }
}

/* ------------------------------------------------------------------ helpers */

async function getJson(url, doFetch, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', ...headers },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'timed out' : String(err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

/** Nominatim's policy requires a User-Agent identifying the application. */
function userAgent(env) {
  const contact = (env.OSCAR_OWNER_EMAIL || '').trim();
  return contact ? `Oscar-Assistant/1.0 (${contact})` : 'Oscar-Assistant/1.0';
}

/** Reject nonsense before it reaches an API, and normalise to 4 decimals (~11m). */
export function normalizeCoords(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // 0,0 is in the Atlantic — it's almost always a missing-value bug, not a place.
  if (lat === 0 && lon === 0) return null;
  return { latitude: Math.round(lat * 1e4) / 1e4, longitude: Math.round(lon * 1e4) / 1e4 };
}

/** "Seattle, Washington, United States" from whatever parts exist. */
export function describePlace(parts) {
  return [parts.name, parts.region, parts.country].filter(Boolean).join(', ');
}

/* --------------------------------------------------------------- geocoding */

/**
 * Place name → coordinates, via Open-Meteo. No API key.
 * @returns {Promise<{latitude,longitude,name,region,country,timezone,population}|null>}
 */
export async function geocodePlace(name, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const query = String(name || '').trim();
  if (!query) return null;

  const url = `${GEOCODE_URL}?${new URLSearchParams({
    name: query,
    count: '5',
    language: 'en',
    format: 'json',
  })}`;

  const result = await getJson(url, doFetch);
  if (!result.ok || !result.data || !Array.isArray(result.data.results)) return null;

  const hits = result.data.results;
  if (!hits.length) return null;

  // Ambiguous names ("Springfield", "Portland") are common. Population is a
  // decent proxy for "the one a person probably means".
  const best = hits.reduce((a, b) => ((b.population || 0) > (a.population || 0) ? b : a));

  return {
    latitude: best.latitude,
    longitude: best.longitude,
    name: best.name,
    region: best.admin1 || null,
    country: best.country || null,
    timezone: best.timezone || null,
    population: best.population || null,
  };
}

/**
 * Coordinates → city name, via Nominatim. Best-effort: returns null on any
 * failure, and callers must cope with that.
 */
export async function reverseGeocode(latitude, longitude, deps = {}) {
  const env = deps.env || process.env;
  if (env.OSCAR_DISABLE_REVERSE_GEOCODE === '1') return null;

  const doFetch = deps.fetchImpl || globalThis.fetch;
  const coords = normalizeCoords(latitude, longitude);
  if (!coords) return null;

  const url = `${REVERSE_URL}?${new URLSearchParams({
    lat: String(coords.latitude),
    lon: String(coords.longitude),
    format: 'jsonv2',
    zoom: '10', // city level; finer zooms return street addresses we don't want
  })}`;

  const result = await getJson(url, doFetch, { 'user-agent': userAgent(env) });
  if (!result.ok || !result.data || !result.data.address) return null;

  const a = result.data.address;
  return {
    name: a.city || a.town || a.village || a.suburb || a.county || null,
    region: a.state || a.region || null,
    country: a.country || null,
  };
}

/**
 * IP → approximate location, via ipapi.co.
 *
 * Deliberately imprecise: this is the ISP's registered location, which can be
 * a different city entirely on mobile networks, and the VPN exit node if you
 * use one. Good enough for "is it going to rain here", not for anything else.
 */
export async function locateByIp(ip, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const address = String(ip || '').trim();

  // Private and loopback addresses geolocate to nothing useful — skip the call.
  if (
    !address ||
    address === 'unknown' ||
    address.startsWith('127.') ||
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    address.startsWith('::1') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  ) {
    return null;
  }

  const result = await getJson(`${IP_LOOKUP_URL}/${encodeURIComponent(address)}/json/`, doFetch);
  if (!result.ok || !result.data || result.data.error) return null;

  const coords = normalizeCoords(result.data.latitude, result.data.longitude);
  if (!coords) return null;

  return {
    ...coords,
    name: result.data.city || null,
    region: result.data.region || null,
    country: result.data.country_name || null,
    timezone: result.data.timezone || null,
  };
}

/* ----------------------------------------------------------------- resolver */

/**
 * The one function the tool actually calls. Works through the sources in order
 * and reports which one won, so the model can hedge its wording when the answer
 * came from an IP guess.
 *
 * @param {{place?: string, coords?: {latitude,longitude}, ip?: string}} input
 * @returns {Promise<{latitude,longitude,name,region,country,timezone,source,accurate:boolean}>}
 */
export async function resolveLocation(input = {}, deps = {}) {
  const env = deps.env || process.env;

  // 1. An explicit place beats everything — if you asked about Tokyo, you want Tokyo.
  if (input.place && String(input.place).trim()) {
    const hit = await geocodePlace(input.place, deps);
    if (hit) return { ...hit, source: 'place', accurate: true };
    throw new LocationError(`I couldn't find a place called "${input.place}".`);
  }

  // 2. GPS from the Shortcut.
  const coords = input.coords && normalizeCoords(input.coords.latitude, input.coords.longitude);
  if (coords) {
    const named = await reverseGeocode(coords.latitude, coords.longitude, deps);
    return {
      ...coords,
      name: (named && named.name) || null,
      region: (named && named.region) || null,
      country: (named && named.country) || null,
      timezone: input.timeZone || null,
      source: 'gps',
      accurate: true,
    };
  }

  // 3. The caller's IP.
  const byIp = await locateByIp(input.ip, deps);
  if (byIp) return { ...byIp, source: 'ip', accurate: false };

  // 4. Whatever you configured as home.
  const home = (env.OSCAR_HOME_LOCATION || '').trim();
  if (home) {
    const hit = await geocodePlace(home, deps);
    if (hit) return { ...hit, source: 'home', accurate: false };
  }

  throw new LocationError(
    'I could not work out where you are. Add a Get Current Location step to the Shortcut, or set OSCAR_HOME_LOCATION.'
  );
}

/* -------------------------------------------------------------------- tool */

/** The schema the model sees. Descriptions matter — they're the model's docs. */
export const locationTool = {
  name: 'get_location',
  description:
    "Resolve a location to coordinates. Call with no arguments to find where the user currently is. " +
    "Pass `place` to look up a named location instead. Returns coordinates, a place name, and how the " +
    "location was determined — if `accurate` is false the position is a rough guess and you should say so.",
  parameters: {
    type: 'object',
    properties: {
      place: {
        type: 'string',
        description:
          "A city, region, or address to look up, e.g. 'Tokyo' or 'Seattle, WA'. Omit entirely to use the user's own location.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  /**
   * @param {object} args   parsed from the model's tool call
   * @param {object} ctx    request context: { coords, ip, timeZone, env, fetchImpl }
   */
  async run(args = {}, ctx = {}) {
    const location = await resolveLocation(
      { place: args.place, coords: ctx.coords, ip: ctx.ip, timeZone: ctx.timeZone },
      ctx
    );

    return {
      latitude: location.latitude,
      longitude: location.longitude,
      place: describePlace(location) || 'an unnamed location',
      timezone: location.timezone,
      source: location.source,
      accurate: location.accurate,
      note: location.accurate
        ? undefined
        : location.source === 'ip'
          ? 'Derived from the IP address, so it may be off by some distance.'
          : 'Fell back to the configured home location.',
    };
  },
};
