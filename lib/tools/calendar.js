/**
 * lib/tools/calendar.js
 * ----------------------------------------------------------------------------
 * Google Calendar: read what's coming up, and add events.
 *
 * Two tools rather than one, because the model picks tools by name and
 * `list_events` / `create_event` are unambiguous in a way that a single
 * `calendar(action)` tool never is. It also means the write half can be
 * withheld entirely from a read-only request — see lib/tools/index.js.
 */

import { googleFetch } from '../google/auth.js';

const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** An all-day event has `date`; a timed one has `dateTime`. Both need handling. */
function readWhen(slot) {
  if (!slot) return { when: null, allDay: false };
  if (slot.date) return { when: slot.date, allDay: true };
  return { when: slot.dateTime || null, allDay: false };
}

function tidyEvent(event) {
  const start = readWhen(event.start);
  const end = readWhen(event.end);
  return {
    id: event.id,
    title: event.summary || '(no title)',
    start: start.when,
    end: end.when,
    allDay: start.allDay,
    location: event.location || null,
    // Descriptions can be enormous — meeting invites paste whole agendas in.
    // The model only needs the gist, and every character costs tokens.
    description: event.description ? String(event.description).slice(0, 300) : null,
    attendees: Array.isArray(event.attendees)
      ? event.attendees.slice(0, 8).map((a) => a.displayName || a.email).filter(Boolean)
      : [],
    hangoutLink: event.hangoutLink || null,
    status: event.status || null,
  };
}

/**
 * Turn "today" / "tomorrow" / "this week" into a concrete window.
 * Done here rather than asking the model for ISO timestamps, because models are
 * unreliable at date arithmetic and it's cheap to be exact.
 */
export function resolveWindow(range = 'today', timeZone, now = new Date()) {
  const start = new Date(now);
  const end = new Date(now);

  switch (String(range).toLowerCase()) {
    case 'now':
    case 'next':
      end.setHours(end.getHours() + 4);
      break;
    case 'tomorrow':
      start.setDate(start.getDate() + 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1);
      end.setHours(23, 59, 59, 999);
      break;
    case 'week':
    case 'this week':
      end.setDate(end.getDate() + 7);
      break;
    case 'month':
      end.setDate(end.getDate() + 30);
      break;
    case 'today':
    default:
      end.setHours(23, 59, 59, 999);
      break;
  }

  return { timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone };
}

export const listEventsTool = {
  name: 'list_events',
  description:
    "Read the user's Google Calendar. Use for anything about their schedule, meetings, what they " +
    "have on, or whether they are free. `range` accepts today, tomorrow, week, month, or next " +
    '(the next few hours). Returns events in time order.',
  parameters: {
    type: 'object',
    properties: {
      range: {
        type: 'string',
        enum: ['now', 'today', 'tomorrow', 'week', 'month'],
        description: 'Which window to look at. Defaults to today.',
      },
      query: { type: 'string', description: 'Optional free-text search across event titles.' },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const window = resolveWindow(args.range || 'today', ctx.timeZone, ctx.now && new Date(ctx.now));

    const params = new URLSearchParams({
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      singleEvents: 'true', // expand recurring events into instances
      orderBy: 'startTime',
      maxResults: '15',
    });
    if (ctx.timeZone) params.set('timeZone', ctx.timeZone);
    if (args.query) params.set('q', String(args.query).slice(0, 100));

    const data = await googleFetch(`${BASE}?${params}`, {}, ctx);
    const events = (data && data.items ? data.items : []).map(tidyEvent);

    return {
      range: args.range || 'today',
      timeZone: ctx.timeZone || null,
      count: events.length,
      events,
      note: events.length ? undefined : 'Nothing scheduled in that window.',
    };
  },
};

export const createEventTool = {
  name: 'create_event',
  description:
    "Add an event to the user's Google Calendar. Times must be full ISO 8601 with an offset, e.g. " +
    "2026-08-18T14:00:00-07:00. Work out the actual date from the current date given in your " +
    'instructions — never guess. If the user did not say how long it runs, use one hour.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What the event is called.' },
      start: { type: 'string', description: 'ISO 8601 start time with offset.' },
      end: { type: 'string', description: 'ISO 8601 end time with offset.' },
      location: { type: 'string', description: 'Optional location.' },
      description: { type: 'string', description: 'Optional notes.' },
    },
    required: ['title', 'start', 'end'],
    additionalProperties: false,
  },

  // Marked so the registry can withhold it from read-only requests.
  writes: true,

  async run(args = {}, ctx = {}) {
    const start = new Date(args.start);
    const end = new Date(args.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('Those start and end times are not valid dates.');
    }
    if (end <= start) throw new Error('The end time has to be after the start time.');

    const body = {
      summary: String(args.title).slice(0, 200),
      start: { dateTime: start.toISOString(), timeZone: ctx.timeZone || undefined },
      end: { dateTime: end.toISOString(), timeZone: ctx.timeZone || undefined },
    };
    if (args.location) body.location = String(args.location).slice(0, 200);
    if (args.description) body.description = String(args.description).slice(0, 1000);

    const created = await googleFetch(BASE, { method: 'POST', body }, ctx);

    return {
      created: true,
      event: tidyEvent(created || {}),
      // Handy for the model to read back so the user can verify it landed right.
      confirmation: `"${body.summary}" added for ${start.toISOString()}`,
    };
  },
};

/**
 * Formats an event for a confirmation prompt. Reads naturally out loud, and
 * includes the day name because "delete the event on Thursday" is exactly the
 * kind of instruction that can match the wrong week.
 */
function describeEventForPrompt(event, timeZone) {
  const start = readWhen(event.start);
  const title = event.summary || '(no title)';

  if (!start.when) return `Delete "${title}"?`;
  if (start.allDay) {
    const day = new Date(`${start.when}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return `Delete "${title}" (all day, ${day})?`;
  }

  const when = new Date(start.when).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timeZone || 'UTC',
  });
  return `Delete "${title}" on ${when}?`;
}

export const deleteEventTool = {
  name: 'delete_event',
  description:
    'Delete an event from the calendar. Call list_events first to find the id — never guess one. ' +
    'This does NOT delete immediately: the user is asked to confirm first, so it is safe to call ' +
    'once you are confident you have the right event. If several events could match what they ' +
    'said, ask which one instead of picking.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Event id, from list_events.' },
    },
    required: ['id'],
    additionalProperties: false,
  },

  writes: true,
  confirm: true,

  /**
   * Runs BEFORE the confirmation is shown. Read-only: it fetches the event so
   * the prompt can name it. Confirming "delete event a1b2c3" is useless; naming
   * the thing is the entire point of asking.
   */
  async describe(args = {}, ctx = {}) {
    const event = await googleFetch(`${BASE}/${encodeURIComponent(args.id)}`, {}, ctx);
    if (!event || event.status === 'cancelled') {
      throw new Error('That event no longer exists.');
    }
    return describeEventForPrompt(event, ctx.timeZone);
  },

  async run(args = {}, ctx = {}) {
    // Fetch first so the confirmation message can name what was removed, and so
    // an already-deleted event gives a clear answer instead of a bare 404.
    let title = 'that event';
    try {
      const event = await googleFetch(`${BASE}/${encodeURIComponent(args.id)}`, {}, ctx);
      if (event && event.summary) title = `"${event.summary}"`;
    } catch {
      /* deleting is still worth attempting */
    }

    await googleFetch(`${BASE}/${encodeURIComponent(args.id)}`, { method: 'DELETE' }, ctx);

    return { deleted: true, id: args.id, confirmation: `Deleted ${title}.` };
  },
};
