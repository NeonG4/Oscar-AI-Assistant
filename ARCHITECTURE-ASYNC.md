# The async architecture — decisions and build order

Your proposal: the Shortcut stops waiting for an answer and just pokes the
server; the website, pinned to your home screen, becomes where Oscar actually
works with you.

This is the right shape, and this document records why, what's already built,
and what's left — so the next session starts from decisions rather than from
scratch.

---

## Why this is better than what we have

The synchronous design has one structural problem: **your phone holds an HTTP
connection open while Oscar thinks.** Everything else follows from that. Tool
rounds have to be capped, confirmations have to be squeezed through Shortcuts'
awkward branching, and answers have to fit in a notification banner.

Cutting that connection removes all three limits at once.

| | Now | After |
| --- | --- | --- |
| Tool rounds | ~12, bounded by a 25s deadline | Effectively unbounded |
| Confirmations | Shortcuts `Choose from Menu` | Real buttons in a real UI |
| Answer length | ~60 words | Whatever's useful |
| Progress | Invisible | "calling get_weather…" as it happens |

---

## The load-bearing facts, verified

**iOS web push works, with two hard requirements.** The site must be added to
the **Home Screen** — a Safari tab gets nothing, they're separate contexts —
and the permission prompt must be triggered by a tap, not on page load. So
"pin it like an app" isn't a nicety, it's the requirement.

**`waitUntil` does not give unbounded background time.** Vercel's docs:
*"Promises passed to waitUntil() will have the same timeout as the function
itself. If the function times out, the promises will be cancelled."* So
background work is capped by `maxDuration` — 60s on Hobby.

**Your fix is the right one, with one refinement.** The budget resets per
**function invocation**, not per tool. So the way to get past 60s is to make
each step of the agent loop its own invocation, with state checkpointed to the
database in between. Each step gets a fresh 60s; the run as a whole is
unbounded.

Two ways to trigger the next invocation, and doing both is best:

- **The PWA drives it** — calls `/api/step` repeatedly while you watch. Gives
  live progress for free.
- **The function drives itself** — before it runs out, it POSTs to its own
  `/api/step` and returns. Progress continues with the app closed.

---

## What's already built

The agent loop has been refactored into a **stepper**, which is the groundwork
everything else needs:

- `createAgentState(input, env)` → plain JSON state
- `runAgentStep(state, deps)` → runs exactly one round, returns
  `{ state, status: 'working' | 'done' | 'confirm' }`
- `askAgent()` is now just a loop over `runAgentStep` under a deadline

The state is deliberately serialisable — no functions, no class instances, no
`Date` objects — and there's a test (`agent state survives a JSON round trip`)
asserting a state can be written out, read back, and continue identically.
**That property is what the whole stepped design rests on**, which is why it's
pinned by a test rather than left as an intention.

Budgets are now time and cost based rather than a round counter. See TOOLS.md.

---

## What's left, in build order

### ~~1. Jobs backend~~ — BUILT

`db/schema.sql` has the `jobs` table; `lib/jobs.js`, `api/jobs.js` and
`api/step.js` implement it. Verified end to end: a deep question returns a job
id immediately, the job runs its steps in the background, and polling returns
the answer plus the tool trace.

A few decisions worth knowing:

- **`/api/step` is locked to a signed, single-job token** or a browser session —
  never the Shortcut key. It spends OpenAI credit in a loop, so the weakest
  credential in the system must not be able to drive it. Each hop mints a fresh
  token for the next.
- **A step stops ~8 seconds before its budget**, so there is always room to write
  the checkpoint and fire the next hop. Running to the wall and losing the state
  would be the worst possible failure.
- **Finished jobs drop their `state`.** The message history is the bulk of the
  row and is useless once answered.
- **Two independent ways to advance a job**: the function hands off to itself,
  and the web app can call `/api/step` while watching. Either alone is enough,
  which is why a dropped hop is recoverable rather than fatal.

### ~~4. Model routing~~ — BUILT

`lib/router.js`. Keyword rules settle the obvious cases with **no model call at
all**; only genuinely unclear questions pay for the classifier, which is capped
at `max_tokens: 5`. If the classifier is slow or broken it falls back to fast —
routing is an optimisation, never a dependency.

### NEXT — 2. PWA shell

- `manifest.json` + `sw.js`, `display: standalone`
- A job view: question, live event log, answer, confirmation buttons
- An "Add to Home Screen" prompt, since push depends on it

### 3. Web push

- Generate VAPID keys, store as env vars
- `POST /api/push/subscribe` from the PWA, after a tap
- Send on job completion

Worth knowing before starting: push needs the PWA installed **and** permission
granted from a user gesture, so the UI has to guide both. Budget more time for
the iOS quirks than the code.

---

## What does NOT change

- `/api/ask` stays exactly as it is. It's proven, and a 3-second notification
  is still the best answer for "what's the weather".
- The write gate, the confirmation tokens, and every tool work unchanged — the
  async path reuses all of it.
- Nothing here requires abandoning the Shortcut. It gets simpler, not deleted.
