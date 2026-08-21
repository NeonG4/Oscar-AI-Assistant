# Tools

Oscar can call out for live data and act on your behalf, instead of guessing.

| File | Tools |
| --- | --- |
| `lib/tools/location.js` | `get_location` |
| `lib/tools/weather.js` | `get_weather` |
| `lib/tools/calendar.js` | `list_events`, `create_event`, `delete_event` |
| `lib/tools/tasks.js` | `list_tasks`, `create_task`, `complete_task`, `delete_task` |
| `lib/tools/gmail.js` | `search_email`, `read_email`, `draft_email`, `send_email`, `trash_email` |
| `lib/tools/drive.js` | `search_drive`, `read_drive_file`, `trash_drive_file` |
| `lib/tools/docs.js` | `create_doc`, `read_doc`, `append_to_doc` |
| `lib/tools/plans.js` | `create_plan`, `list_plans`, `get_plan`, `add_plan_steps`, `complete_plan_step`, `update_plan`, `delete_plan` |
| `lib/tools/checklist.js` | `plan_tasks`, `finish_task` |

The Google ones need [GOOGLE.md](./GOOGLE.md) set up first, and the plan ones
need [SUPABASE.md](./SUPABASE.md); weather and location work out of the box. Anything that changes data is withheld unless the request
proved write authority, and anything destructive asks first when dictated — see
[Destructive actions](#destructive-actions).

**Three of those tool groups make a list of steps, and they belong to different
people.** A **task** is Oscar's: `plan_tasks` and `finish_task` edit the list he
shows his working on, and it dies with the run. A **plan** is yours:
`create_plan` and the rest of that group save it in the database for you to tick
off next week. A **to-do** is yours as well, but it lives in your Google account
— that is what `list_tasks` and `create_task` reach. Google calls its to-dos
"tasks", which is exactly why the line is worth stating out loud: in this
codebase an unqualified **task is always Oscar's own**.

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

## Public lookups

Three read-only tools for finding out who a username belongs to, from profiles
people published themselves. They need no key and change nothing, so they sit
alongside the weather rather than behind the write gate.

### `find_username`

| Argument | Type | Meaning |
| --- | --- | --- |
| `username` | string, required | The handle. A leading `@`, or a pasted profile URL, is fine. |
| `sites` | array, optional | Restrict to particular sites. Omit to check all eleven. |

Returns `found`, `unknown` and `absent`, plus `notChecked` for the sites that
cannot be probed at all. The three states are the point: a site that could not be
reached is reported as unknown rather than being rounded down to "no account".

### `lookup_profile`

| Argument | Type | Meaning |
| --- | --- | --- |
| `site` | string, required | One of the catalogue ids. |
| `username` | string, required | The handle on that site. |

The read step after the search step. Adds recently-pushed repositories on GitHub.

### `lookup_domain`

| Argument | Type | Meaning |
| --- | --- | --- |
| `domain` | string, required | `example.com`. A full URL is trimmed down. |

Registrar, registration and expiry dates, and nameservers, over RDAP. Registrant
details are redacted on almost every domain since GDPR, and the result says so
rather than implying the owner is hiding.

**[OSINT.md](./OSINT.md) is the full account** — the catalogue, why three states
instead of two, the sites that are deliberately not probed, and where the
boundary is drawn.

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

All of them are free and need no API key, which is why the project still has no
signup requirements beyond OpenAI.

| Service | Used for | Limits |
| --- | --- | --- |
| [Open-Meteo](https://open-meteo.com) | Forecasts | 600/min, <10k/day, non-commercial |
| [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) | Place name → coordinates | Same |
| [Nominatim](https://nominatim.openstreetmap.org) | Coordinates → city name | ~1 request/second, needs an identifying User-Agent |
| Eleven public profile APIs | Username lookups | See [OSINT.md](./OSINT.md). GitHub's 60/hour is the only one you are likely to hit |
| [rdap.org](https://rdap.org) | Domain registration records | Bootstrap redirector to each registry |

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
| `OSCAR_DISABLE_OSINT` | *(unset)* | `1` withholds the three public-lookup tools. |
| `OSCAR_GITHUB_TOKEN` | *(unset)* | Raises GitHub's rate limit for username lookups. Needs no scopes. |
| `OSCAR_DISABLE_REVERSE_GEOCODE` | *(unset)* | `1` skips Nominatim. Answers say "your location" instead of naming a city. |

---

## Design decisions worth knowing

**The agent runs until the work is done, not until a round counter expires.**
It will happily chain a dozen tool calls — look something up, use that to look
up the next thing, then act. A raw round cap was the wrong control; what
actually matters is how long you'll wait and what it costs, so those are the
budgets:

| Budget | Default | Why |
| --- | --- | --- |
| `OSCAR_TOOL_DEADLINE_MS` | 25000 | The real limit on the sync path — an iOS Shortcut gives up long before a dozen rounds |
| `OSCAR_MAX_TOOL_ROUNDS` | 12 | Backstop against a stuck model, not a design constraint |
| `OSCAR_MAX_TOOL_CALLS` | 40 | Total tool executions, so cost stays bounded |

When a budget runs out, tools are **withheld** and the model is told why, so it
answers with what it found rather than stalling. Withholding is what guarantees
termination: the model cannot call a tool it was never offered.

**Repeated identical calls are refused on the third try.** Two are fine —
re-reading a plan you just changed is legitimate — but a third gets an error
telling the model to use the result it already has. That kills the classic
tool-loop without breaking real work.

**The loop is a stepper, not a `for`.** `runAgentStep()` does exactly one round
and hands back plain JSON state; `askAgent()` just calls it repeatedly under a
deadline. That separation is what allows a run to be spread across many
serverless invocations later — each with its own fresh execution budget — since
the state can be written to a database in between. There's a test asserting
state survives a JSON round trip, because that property is what the whole
design rests on.

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

## Plans

A plan is a goal broken into ordered steps you can tick off. Unlike everything
else, this is data Oscar **owns** rather than reads from someone else's API.

```
you:    "plan my move to Seattle"
Oscar:  Saved "Move to Seattle" with 3 steps. First up: Book movers.

you:    "what's next on my move plan?"
Oscar:  Book movers.

you:    "mark step 1 done"
Oscar:  Ticked off "Book movers". Next: Pack the kitchen.
```

### Design decisions

**Oscar writes the steps.** `create_plan` requires them, and the tool
description tells the model to produce 3–8 concrete actions ordered so earlier
ones unblock later ones, with no filler. Recording dictation verbatim would put
the thinking back on you, which is the opposite of the point.

**Plans are addressed by name, never by id.** Nobody says "plan 7". Every tool
takes a `plan` string and resolves it fuzzily, so "my move plan" finds "Move to
Seattle". If the name is ambiguous it **refuses and names the candidates**
rather than guessing — picking the wrong plan and then deleting it is the
failure mode worth designing against.

**Steps are addressed by number, not row id.** "Mark step 2 done" works with no
lookup round trip, because `step_number` is what the model passes.

**`nextStep` is surfaced separately** from the steps array, because "what's
next" is the most likely question and the model shouldn't have to scan a list
to answer it.

**Two tables, not one JSON blob.** Ticking a step is a single UPDATE rather
than a read-modify-write of the whole plan.

**Plan tools are withheld without a database** — unlike logging, which no-ops
silently. Accepting a plan and quietly dropping it would be far worse than
saying "I can't store plans". `/api/health` reports `plans.available`.

**Nothing is saved until `OSCAR_ALLOW_WRITES=1`.** Without it `create_plan` is
never offered to the model, so "what are my plans?" answers "none yet" and no
error appears anywhere. Check `/api/health` → `writes.enabled`.

**Reading is free, changing needs write permission.** `list_plans` and
`get_plan` work from the read-only Shortcut; everything else needs write
authority. `delete_plan` also asks for confirmation when dictated.

### Tools

| Tool | Write? | What it does |
| --- | :---: | --- |
| `list_plans` | | Active plans by default; `status: "all"` for everything |
| `get_plan` | | One plan in full, with progress and what's next |
| `create_plan` | ✅ | Title, goal, and the steps Oscar drafts |
| `add_plan_steps` | ✅ | Append steps, numbered automatically |
| `complete_plan_step` | ✅ | Tick step N off, or un-tick with `done: false` |
| `update_plan` | ✅ | Retitle, re-goal, set due date, or set status |
| `delete_plan` | ✅ | Deletes the plan and its steps — asks first |

Finished a plan? Prefer `update_plan` with `status: "done"` over deleting it.
There's no permanent-loss path that doesn't ask first.

---

## People

The people you know: who they are to you, and how to reach them. Like plans,
this is data Oscar **owns**. Unlike plans — or anything else here — most of it
is never explicitly given.

```
you:    "I'm writing to my sister, Olivia, who has a cold.
         What's the best way to talk to her?"
Oscar:  Keep it short and warm, ask how she's sleeping, and don't
         offer advice unless she asks.

        (Olivia is quietly filed as your sister. The cold is not.)

you:    "what's my sister's email?"
Oscar:  olivia@example.com.

you:    "Olivia is my stepsister actually, fix that"
Oscar:  Updated Olivia.
```

### Background catching

The passive half. It is **off until you turn it on** — Settings → Remembering
people, or `background_catching` in the `settings` table.

With it on, every question you ask is read once more after it has been
answered, and anything durable about a person is written to `people`. With it
off, nothing is stored unless you ask for it, and `remember_person` still works
exactly as it always did. That split is the whole design: a passing mention is
governed by the toggle, a direct request never is.

**Only what is still true in a year.** "My sister Olivia" is a fact. "Olivia has
a cold" is not — it is true for a week and actively misleading afterwards, and
an assistant that raises a cold from last March is worse than one that never
listened. The person is still recorded from a sentence like that; the cold is
what gets dropped. This is the rule a model is most likely to get wrong, so most
of the extraction prompt in `lib/catch.js` is spent on it.

**Only your words, never Oscar's.** The question is read; the answer is not.
Generated prose contains invented details, and feeding those back into a table
Oscar later treats as fact is how you end up with an address book full of things
nobody ever said.

**A caught fact can fill a gap, never overwrite one.** Everything from this path
is stored with `source: 'background'`, and `mergePerson()` will let it complete
an empty field but never replace a full one. So a misheard sentence can add
something you can see and delete; it cannot quietly rewrite what you told him
directly. Confirming an inferred fact yourself promotes the row to `explicit`,
and it never travels back the other way.

**Most questions never reach the model.** `worthCatching()` is a keyword gate in
front of the extraction call — the same trick the router uses, for the same
reason. "What's the weather" has no person in it and costs nothing. The gate is
deliberately conservative in the cheap direction: it misses quiet mentions like
"Tom moved to Denver", because a missed fact costs you one sentence to state
explicitly while a model call on every timer costs money forever.

**It never delays or breaks an answer.** The extraction call is started when the
question arrives, so it overlaps the agent's own work rather than being added to
the end of it, and every failure inside it is swallowed and logged. The question
has already been answered by the time any of it matters.

### Design decisions

**One row per name, enforced by the database.** `name` is what you *call* them —
"Olivia", not "Olivia Margaret Stall" — because that is the word you will say
when you want her back. A unique index on `lower(name)` is what makes "add this
to Olivia" a merge rather than a second Olivia, including when two mentions race
each other. Genuinely two Olivias? The second gets a distinguishing name, which
is what you would say out loud anyway once one Olivia was ambiguous.

**People are addressed by name or by relationship.** `get_person` takes what you
actually said, so both "Olivia" and "my sister" resolve. Ambiguity **refuses and
names the candidates** rather than guessing — handing back the wrong brother's
email address is the failure worth designing against.

**Arrays for emails, phones and notes.** Learning a second address is new
information, never a correction of the first, so those merge as a union at every
trust level. Notes cap out at 20 with the *oldest* falling off, because what
someone is doing now is worth more than what they were doing a year ago.

**`birthday` is text, not a date.** "March 4th" is a real answer people give, and
a date column would force Oscar to invent a year to store it.

**Where a fact came from is on every read.** `source` comes back with every
person, so "where did you get that?" is answerable without a second lookup, and
a fact Oscar inferred is labelled as inferred every time it is repeated.

**People tools are withheld without a database**, like plans — accepting a name
and dropping it would be worse than having no people tools.

**Reading is free, changing needs write permission.** `list_people` and
`get_person` work from the read-only Shortcut; the other two need write
authority. Background catching writes without any tool at all, which is exactly
why it has its own switch rather than riding on `OSCAR_ALLOW_WRITES`.

### Tools

| Tool | Write? | What it does |
| --- | :---: | --- |
| `list_people` | | Everyone on file, most recently mentioned first |
| `get_person` | | One person in full, by name or by relationship |
| `remember_person` | ✅ | Save or update someone — **only when asked to** |
| `forget_person` | ✅ | Deletes them and everything on file — asks first |

`remember_person`'s description leans hard on that "only when asked to", and so
does the system prompt. If the model filed away everyone it heard about, the
setting would quietly stop meaning anything — which is a worse outcome than the
feature simply being off.

Changed your mind about the whole thing? This keeps everything you asked for and
forgets everything Oscar worked out on his own:

```sql
delete from public.people where source = 'background';
```

---

## Tasks — Oscar showing his working

Anything that takes more than one step gets a list first. Oscar calls
`plan_tasks` with what he is about to do, then `finish_task` after each one, and
the web console renders the list ticking off as it happens. This list is his,
not yours — you watch it, you never tick it off.

```
you: "compare the two flights and tell me which is better"
         │
         ▼
   plan_tasks({tasks: ["Find both flights", "Compare price and times", "Say which wins"]})
         │  the console draws three tasks, the first one current
         ▼
   ... real work ...
         │
         ▼
   finish_task({task: 1, note: "Both found — 08:10 and 14:35"})
         │  task 1 ticks off, task 2 becomes current
         ▼
   ... and so on, then the answer
```

**These tools change nothing.** No database, no Google account, no write
permission — they edit a list that lives inside the run's own state, which is
why they are available on a deployment with nothing configured at all. The list
is thrown away with the run; it is a progress indicator, not a record.

**A run cannot finish over an open task.** If the model writes a final answer
while the list still has unticked items, the answer is refused rather than
accepted: it is told which task it owes, reminded that a task which cannot be
done is closed with `finish_task` and an honest note, and sent back to work.
Only an empty list lets an answer through.

That gate cannot be infinite, or a model determined to stop would spend the
whole round budget being asked again. After three refusals — or once the rounds,
the tool calls or the clock run out — the run ends and is recorded as
`incomplete` rather than `done`. The notification says "Stopped early", the
console says so, and the unfinished list stays on screen underneath. What none
of them do is print "finished" over a list that plainly is not.

**Numbering is assigned by the server, not the model.** `lib/tasklist.js`
renumbers whatever list arrives from 1, and every `finish_task` result hands the
whole renumbered list back — which is what stops the model's idea of "task 3"
and Oscar's from drifting apart over a long run.

| Tool | Write? | What it does |
| --- | :---: | --- |
| `plan_tasks` | | 2–12 ordered tasks, at the start of a run. Refuses a list of one |
| `finish_task` | | Ticks task N off, with one line on how it went |

### Tasks vs plans vs to-dos vs missions

Four similar-sounding things, told apart by whose they are and how long they
last:

| | Whose | Lives for | Stored in | You can |
| --- | --- | --- | --- | --- |
| **Task** | Oscar's | one run | the run's state | watch it |
| **Plan** | yours | until you delete it | `plans` table | tick steps off next week |
| **To-do** | yours | until you delete it | your Google account | ask him to add or tick one |
| **Mission** | Oscar's | one run, working its own list | `jobs` + `plans` | watch it, and keep what it built |

A mission does not call `plan_tasks`. It draws up its own list at the start and
`lib/missions.js` mirrors that list into the same shape, so the console renders
both identically.

One overlap to know about: a mission's task list is *stored* as a row in the
`plans` table. Oscar's working memory therefore shares a drawer with the plans
you saved yourself, and shows up in `list_plans` alongside them. The words are
now kept apart everywhere they are used; the storage is not.

---

## Destructive actions

Four tools can remove things: `delete_event`, `delete_task`, `trash_email` and
`trash_drive_file`. Two properties apply to all of them.

**Nothing is destroyed permanently.** `trash_email` calls Gmail's `/trash`, not
its permanent delete, and `trash_drive_file` PATCHes `trashed: true` rather than
issuing Drive's `DELETE` — both leave the item in a bin for 30 days. The
irrecoverable endpoints of both APIs are deliberately not wired up at all. This
matters more in Drive than in Gmail: Drive's `DELETE` doesn't bin a file, it
destroys it, with no undo anywhere in the product.

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

## When the answer is too long to say

A notification is capped at `OSCAR_MAX_WORDS` (60 by default), which is the
right size for "18°C and clearing up" and hopeless for a workout plan. The
resolution is not a longer notification — it's `create_doc`.

Ask for something substantial and Oscar writes the real content into a Google
Doc, then tells you it's ready and hands you the link. The spoken answer stays
short because the substance went somewhere that can hold it. The system prompt
pushes for this explicitly, because the failure mode otherwise is a model
compressing a plan into three useless sentences.

`append_to_doc` covers the running-notes case — a journal, a log, a list you add
to over weeks — without creating a new document every time. It only appends; it
cannot edit or delete what's already in a document you wrote. That's a
deliberate limit, not a missing feature.

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
