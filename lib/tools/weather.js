/**
 * lib/tools/weather.js
 * ----------------------------------------------------------------------------
 * Current conditions and a short forecast, from Open-Meteo.
 *
 * Open-Meteo needs no API key and no signup for personal use — 600 requests a
 * minute, well under 10,000 a day. That's the reason it's here rather than
 * OpenWeatherMap: it keeps the project's "no accounts required" property.
 *
 * COMPOSITION NOTE. This tool can take a place name directly, which looks like
 * it duplicates get_location. It doesn't — it calls the same geocoder from
 * lib/tools/location.js internally. The reason is latency: your phone is
 * waiting on this request, and making the model call get_location and then
 * get_weather costs a whole extra model round trip (roughly 1-2 seconds) for
 * something the server can do in one hop. The tools stay independent; the
 * expensive path is just optional.
 */

import { geocodePlace, resolveLocation, describePlace, normalizeCoords } from './location.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 5000;

export class WeatherError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WeatherError';
  }
}

/**
 * WMO 4677 weather codes. Open-Meteo returns a bare integer, which means
 * nothing to a language model, so translate it here rather than hoping the
 * model knows the table.
 */
export const WEATHER_CODES = {
  0: 'clear',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'foggy',
  48: 'freezing fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  56: 'freezing drizzle',
  57: 'heavy freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'heavy freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers',
  81: 'showers',
  82: 'violent showers',
  85: 'light snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorms',
  96: 'thunderstorms with hail',
  99: 'thunderstorms with heavy hail',
};

export function describeCode(code) {
  return WEATHER_CODES[Number(code)] || 'unsettled';
}

/** Imperial unless told otherwise — set OSCAR_UNITS=metric to flip everything. */
export function unitSet(env = process.env) {
  const metric = String(env.OSCAR_UNITS || 'imperial').toLowerCase() === 'metric';
  return metric
    ? {
        temperature_unit: 'celsius',
        wind_speed_unit: 'kmh',
        precipitation_unit: 'mm',
        labels: { temp: '°C', wind: 'km/h', rain: 'mm' },
      }
    : {
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        precipitation_unit: 'inch',
        labels: { temp: '°F', wind: 'mph', rain: 'in' },
      };
}

const round = (value, places = 0) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Number(Number(value).toFixed(places));

/**
 * Fetch the forecast for a fixed point.
 *
 * @param {{latitude:number, longitude:number, days?:number}} input
 * @returns {Promise<{current: object, daily: object[], units: object}>}
 */
export async function fetchWeather(input, deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetchImpl || globalThis.fetch;

  const coords = normalizeCoords(input.latitude, input.longitude);
  if (!coords) throw new WeatherError('Those coordinates are not valid.');

  const days = Math.min(Math.max(Number(input.days) || 1, 1), 7);
  const units = unitSet(env);

  const url = `${FORECAST_URL}?${new URLSearchParams({
    latitude: String(coords.latitude),
    longitude: String(coords.longitude),
    current: [
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_gusts_10m',
      'is_day',
    ].join(','),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'precipitation_probability_max',
      'wind_speed_10m_max',
      'sunrise',
      'sunset',
    ].join(','),
    forecast_days: String(days),
    // 'auto' makes Open-Meteo return times in the location's own zone, which is
    // what you want when asking about somewhere other than where you are.
    timezone: 'auto',
    temperature_unit: units.temperature_unit,
    wind_speed_unit: units.wind_speed_unit,
    precipitation_unit: units.precipitation_unit,
  })}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await doFetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
  } catch (err) {
    throw new WeatherError(
      err && err.name === 'AbortError'
        ? 'The weather service took too long to respond.'
        : 'Could not reach the weather service.'
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new WeatherError(`The weather service returned an error (HTTP ${res.status}).`);

  let payload;
  try {
    payload = JSON.parse(await res.text());
  } catch {
    throw new WeatherError('The weather service sent something unreadable.');
  }

  const c = payload.current || {};
  const d = payload.daily || {};

  const current = {
    temperature: round(c.temperature_2m),
    feelsLike: round(c.apparent_temperature),
    humidity: round(c.relative_humidity_2m),
    precipitation: round(c.precipitation, 2),
    conditions: describeCode(c.weather_code),
    windSpeed: round(c.wind_speed_10m),
    windGusts: round(c.wind_gusts_10m),
    isDaytime: c.is_day === 1 || c.is_day === true,
    observedAt: c.time || null,
  };

  const dates = Array.isArray(d.time) ? d.time : [];
  const daily = dates.map((date, i) => ({
    date,
    conditions: describeCode(d.weather_code && d.weather_code[i]),
    high: round(d.temperature_2m_max && d.temperature_2m_max[i]),
    low: round(d.temperature_2m_min && d.temperature_2m_min[i]),
    precipitation: round(d.precipitation_sum && d.precipitation_sum[i], 2),
    chanceOfRain: round(d.precipitation_probability_max && d.precipitation_probability_max[i]),
    maxWind: round(d.wind_speed_10m_max && d.wind_speed_10m_max[i]),
    sunrise: (d.sunrise && d.sunrise[i]) || null,
    sunset: (d.sunset && d.sunset[i]) || null,
  }));

  return { current, daily, units: units.labels, timezone: payload.timezone || null };
}

/* -------------------------------------------------------------------- tool */

export const weatherTool = {
  name: 'get_weather',
  description:
    'Get current weather and a short forecast. Call with no arguments for the weather where the user is ' +
    "right now. Pass `place` for somewhere else, or `latitude`/`longitude` if you already have them from " +
    'get_location. Set `days` above 1 only when the user asks about the forecast rather than right now. ' +
    'Temperatures and wind come back in the units the response specifies — always state the unit.',
  parameters: {
    type: 'object',
    properties: {
      place: {
        type: 'string',
        description:
          "A city or region, e.g. 'Tokyo'. Omit to use the user's current location.",
      },
      latitude: { type: 'number', description: 'Latitude, if already known.' },
      longitude: { type: 'number', description: 'Longitude, if already known.' },
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 7,
        description: 'How many days of forecast. 1 (the default) means today only.',
      },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    let point = null;
    let label = null;

    // Coordinates handed over by a previous get_location call.
    const given = normalizeCoords(args.latitude, args.longitude);
    if (given) {
      point = given;
      label = args.place || null;
    } else if (args.place && String(args.place).trim()) {
      const hit = await geocodePlace(args.place, ctx);
      if (!hit) throw new WeatherError(`I couldn't find a place called "${args.place}".`);
      point = { latitude: hit.latitude, longitude: hit.longitude };
      label = describePlace(hit);
    } else {
      const here = await resolveLocation(
        { coords: ctx.coords, ip: ctx.ip, timeZone: ctx.timeZone },
        ctx
      );
      point = { latitude: here.latitude, longitude: here.longitude };
      label = describePlace(here) || 'your location';
      if (!here.accurate) label += ' (approximate)';
    }

    const weather = await fetchWeather({ ...point, days: args.days }, ctx);

    return {
      place: label || 'the requested location',
      units: weather.units,
      current: weather.current,
      // Only include the daily array when more than today was asked for —
      // otherwise it's a lot of tokens the model doesn't need.
      forecast: (Number(args.days) || 1) > 1 ? weather.daily : weather.daily.slice(0, 1),
    };
  },
};
