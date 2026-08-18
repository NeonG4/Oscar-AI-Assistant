# Tools

Oscar can call out for live data and act on your behalf, instead of guessing.

| File | Tools |
| --- | --- |
| `lib/tools/location.js` | `get_location` |
| `lib/tools/weather.js` | `get_weather` |
| `lib/tools/calendar.js` | `list_events`, `create_event`, `delete_event` |
| `lib/tools/tasks.js` | `list_tasks`, `create_task`, `complete_task`, `delete_task` |
| `lib/tools/gmail.js` | `search_email`, `read_email`, `draft_email`, `send_email`, `trash_email` |

The Google ones need [GOOGLE.md](./GOOGLE.md) set up first; weather and location
work out of the box. Anything that changes data is withheld unless the request
proved write authority, and anything destructive asks first when dictated — see
[Destructive actions](#destructive-actions).

```
you: "do I need a jacket?"
         │
         ▼
   api/ask.js ──▶ lib/agent.js
                     │  round 1: here are your tools, what do you need?
                     ▼
                  model: call get_weather({})
                     │
                     ▼
              lib/tools/weather.js
                     │  no place given → ask location where "here" is
                     ▼
              lib/tools/location.js ──▶ GPS? IP? home?
                     │
                     ▼  coordinates
              api.open-meteo.com
                     │  57°F, light rain
                     ▼
                  model: round 2, now with the data
                     │
                     ▼
        "Yes — 57 and raining. Take the jacket."
```

---

## The tools

### `get_location`

Works out where you are, or where a named place is.

| Argument | Type | Meaning |
| --- | --- | --- |
| `place` | string, optional | A city or region to look up. Omit it to mean "where the user is". |

Returns coordinates, a human place name, and — importantly — `accurate` and
`source`. The model is instructed to hedge its wording when `accurate` is false,
so an IP-based guess reads as "roughly Seattle" rather than a confident claim.

### `get_weather`

Current conditions and up to seven days of forecast.

| Argument | Type | Meaning |
| --- | --- | --- |
| `place` | string, optional | Somewhere other than your current location. |
| `latitude` / `longitude` | number, optional | If already known from `get_location`. |
| `days` | integer 1–7, optional | Defaults to 1, meaning today only. |

---

## How location is worked out

Four sources, tried in order. The first that works wins:

| Priority | Source | Accuracy | Needs |
| --- | --- | --- | --- |
| 1 | A place name in your question | Exact | Nothing — "weather in Tokyo" |
| 2 | GPS from the Shortcut | Metres | A **Get Current Location** action |
| 3 | Your IP address | City-ish | Nothing |
| 4 | `OSCAR_HOME_LOCATION` | Whatever you set | The env var |

**Add the GPS step.** IP geolocation returns your ISP's registered location,
which on a mobile network can be a different city entirely, and on a VPN is
wherever the exit node lives. Instructions are in
[SHORTCUT.md](./SHORTCUT.md#giving-oscar-your-location).

---

## Services used

All three are free and need no API key, which is why the project still has no
signup requirements beyond OpenAI.

| Service | Used for | Limits |
| --- | --- | --- |
| [Open-Meteo](https://open-meteo.com) | Forecasts | 600/min, <10k/day, non-commercial |
| [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) | Place name → coordinates | Same |
| [Nominatim](https://nominatim.openstreetmap.org) | Coordinates → city name | ~1 request/second, needs an identifying User-Agent |

### The one that isn't here, and why

The obvious pick for coordinates → city name is BigDataCloud's
`reverse-geocode-client` endpoint — free, keyless, widely recommended. Its fair
use policy **explicitly forbids server-side calls**, and breaching it returns
HTTP 402 and can get your IP banned. Every call Oscar makes comes from a Vercel
function, so that endpoint is unusable here no matter how convenient it looks.
Nominatim permits server-side use at low volume provided you identify yourself,
which `lib/tools/location.js` does using your `OSCAR_OWNER_EMAIL`.

Reverse geocoding is only a nicety — it turns `47.61, -122.33` into "Bellevue"
so answers read better. Every failure degrades to "your location" rather than
breaking the request.

---

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `OSCAR_UNITS` | `imperial` | `imperial` = °F/mph/inches. `metric` = °C/km/h/mm. |
| `OSCAR_HOME_LOCATION` | *(unset)* | Last-resort location, e.g. `Seattle, WA`. |
| `OSCAR_DISABLE_TOOLS` | *(unset)* | `1` turns all tools off. Useful for isolating a problem. |
| `OSCAR_DISABLE_REVERSE_GEOCODE` | *(unset)* | `1` skips Nominatim. Answers say "your location" instead of naming a city. |

---

## Design decisions worth knowing

**The loop is capped at three rounds.** Each round is a full model round trip,
and your phone is waiting. Three covers the deepest real chain: look it up, act
on it, answer — "delete the event on Thursday" needs `list_events` then
`delete_event` before it can say anything. Without a cap, a confused model can
ping-pong tool calls until the request times out. On the final round tools are
withheld entirely, so the model has no option but to answer.

**`get_weather` can take a place name, which looks like it duplicates
`get_location`.** It doesn't — it calls the same geocoder directly. Making the
model call `get_location` and then `get_weather` costs an extra model round trip
(1–2 seconds) for something the server does in one hop. The tools stay
independent; the expensive path is just optional.

**A failing tool never fails the request.** `runTool` catches everything and
returns `{ error }`, which goes back to the model as the tool result. The model
then says "I couldn't get the weather" in its own words. A dead upstream
degrades the answer instead of destroying it — there's a test asserting exactly
this.

**Tool calls in one round run in parallel.** If the model asks for two things at
once, they're fetched concurrently rather than in sequence.

**Coordinates are never written to the database.** The `conversations` table
gains a `tools_used` column holding tool *names* only. Tool results routinely
contain your exact position, and a permanent log of where you were standing each
time you asked about the weather is not something to create by accident.

---

## Latency

Roughly, on top of a normal answer:

| Step | Typical |
| --- | --- |
| Extra model round trip | 700–1500ms |
| Open-Meteo forecast | 100–300ms |
| Nominatim reverse geocode | 200–500ms |
| **Total added** | **~1–2 seconds** |

A weather question lands in about 3–5 seconds rather than 2–3. If that bothers
you, set `OSCAR_DISABLE_REVERSE_GEOCODE=1` to skip the city name.

---

## Destructive actions

Three tools can remove things: `delete_event`, `delete_task` and `trash_email`.
Two properties apply to all of them.

**Nothing is destroyed permanently.** `trash_email` calls Gmail's `/trash`, not
its permanent delete — the message sits in the bin for 30 days. Gmail's
irrecoverable delete endpoint is deliberately not wired up at all.

**They ask first, on the routes where asking matters.** A tool marked
`confirm: true` doesn't act on the first call. It runs a read-only `describe()`
to look up the target, and returns a question naming it — *Delete "Dentist" on
Thursday, August 20 at 2:00 PM?* — plus an HMAC-signed token. Only when
`/api/confirm` replays the call with that token does anything happen.

Naming the target is the whole point. Confirming *"delete event a1b2c3?"* tells
you nothing, so `describe()` fetches the real thing before asking.

### Who gets asked

| Route | Asks first? | Why |
| --- | :---: | --- |
| Shortcut (dictated) | Yes | Speech gets misheard, and no screen shows you what matched |
| Web console, typed | No | You typed it deliberately with the answer in front of you |
| Web console, mic | Yes | The microphone is the risky input wherever it is |

`OSCAR_CONFIRM_ALWAYS=1` forces it everywhere. `OSCAR_CONFIRM_SEND=1` extends it
to sending email.

The default in `runTool` is to *ask*, so a caller that forgets to set the policy
gets the cautious behaviour rather than the destructive one.

### The token

`lib/confirm.js` signs `{tool, args, prompt}` with `OSCAR_SESSION_SECRET` and a
5-minute expiry. Because the arguments are inside the signature, a token
authorising *delete event abc* cannot be edited into *delete event xyz* —
changing one byte invalidates it. Rotating `OSCAR_SESSION_SECRET` invalidates
every outstanding confirmation.

`/api/confirm` re-checks write authority as well as the token, since the token
proves *what* was agreed to, not *who* is asking now.

**Known limit:** with no store, a token can't be enforced as strictly
single-use, so within its 5 minutes it could be replayed. For deletes that's
near-harmless — deleting an already-deleted thing just fails — and the
alternative is a database on the critical path. If that stops being acceptable,
the fix is one row in Supabase keyed on the token id.

### Adding confirmation to your own tool

Set `confirm: true` and add a `describe(args, ctx)` that returns a question
naming the target. `describe` must be read-only — it runs before the user has
agreed to anything.

---

## Adding your own tool

1. Create `lib/tools/yourthing.js` exporting a definition:

```js
export const yourTool = {
  name: 'do_the_thing',
  description: 'Written for the model to read — say when to call it, not just what it does.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to look up.' } },
    required: ['query'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // ctx = { coords, ip, timeZone, env, fetchImpl }
    return { answer: 'something the model can use' };
  },
};
```

2. Add it to `TOOLS` in `lib/tools/index.js`. Nothing in `lib/agent.js` changes.

3. Write tests against a fake `fetchImpl` — see the `location tool` and
   `weather tool` sections in `test/smoke.js`. Every tool takes its fetch from
   `ctx`, precisely so it can be tested without network access.

Two things to get right: the `description` is the model's only documentation, so
spend time on it; and `run` should throw a readable, user-facing message on
failure, because that text can end up in your notification.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| A delete is confirmed but nothing happens | The Shortcut's confirmation branch isn't built — see SHORTCUT.md |
| "That confirmation has expired" | Tokens last five minutes. Ask again |
| Deleting from the web asks for confirmation | `OSCAR_CONFIRM_ALWAYS=1` is set |
| "I don't have access to real-time weather" | Tools disabled (`OSCAR_DISABLE_TOOLS=1`), or the model didn't call one — check the `tools` array in the response |
| Weather is for the wrong city | Falling back to IP. Add the GPS step to your Shortcut |
| "I could not work out where you are" | No GPS, private/unknown IP, and no `OSCAR_HOME_LOCATION` |
| Answers say "your location" and never a city name | Nominatim rate-limited or blocked — harmless, everything else still works |
| Weather questions are slow | Expected: ~1–2s extra. Disable reverse geocoding to claw some back |
| Wrong units | Set `OSCAR_UNITS`, then redeploy |
