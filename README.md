# Oscar

Talk to your phone, get an answer back as a notification.

You say *"Hey Siri, Ask Oscar"*, speak a question, and a few seconds later a
notification appears with the answer. Under the hood it's an iOS Shortcut
posting your dictated text to a tiny Vercel function, which asks an OpenAI model
for an answer written to fit on a lock screen.

```
 iPhone                          Vercel                    OpenAI
 ──────                          ──────                    ──────
 "Hey Siri, Ask Oscar"
   → Dictate Text
   → POST /api/ask  ─────────▶  api/ask.js
       x-oscar-key header         auth + parse
                                  lib/agent.js  ─────────▶  chat completion
                                                            (JSON: title,
                                  ◀───────────────────────   answer, detail)
   ◀────── { title, answer } ──  200 OK
   → Show Notification


 Browser                         Vercel
 ───────                         ──────
   → password  ──────────────▶  api/auth.js  ──▶ emails you a 6-char code
   ◀── signed challenge token
   → challenge + code  ──────▶  api/auth.js  ──▶ Set-Cookie: signed session
   → /api/ask with cookie
```

## What's in here

| File                | Role                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `api/ask.js`        | The endpoint the Shortcut hits. Accepts a session cookie **or** the key.  |
| `api/auth.js`       | Login: password → emailed code → session cookie. Also logout.             |
| `api/session.js`    | "Am I signed in?" — the page asks this on load.                          |
| `api/confirm.js`    | Phase two of a destructive action: verify the token, then act.             |
| `api/jobs.js`       | Read background jobs: status, live tool trace, answer.                    |
| `api/step.js`       | Advances one job per invocation. This is what removes the 60s ceiling.    |
| `api/history.js`    | Reads back the log. Session login only — not the Shortcut key.            |
| `api/health.js`     | `GET /api/health` — confirms your env vars landed. Never echoes them.     |
| `lib/agent.js`      | The agent: prompt, model call, cleanup. No HTTP, so it's testable.        |
| `lib/auth.js`       | Signed tokens, code generation, cookies, constant-time comparisons.       |
| `lib/mailer.js`     | Sends the code. Auto-detects Resend / Postmark / SendGrid.                |
| `lib/http.js`       | Body parsing, JSON replies, CORS rules.                                   |
| `lib/confirm.js`    | Signed, short-lived confirmation tokens for deletes.                      |
| `lib/jobs.js`       | Async runs, checkpointed between serverless invocations.                  |
| `lib/router.js`     | Decides fast-inline vs deep-background vs mission, and which model.       |
| `lib/missions.js`   | Work that plans itself then does itself. Its task list is the memory.     |
| `lib/questions.js`  | Things Oscar has stopped to ask you, and your answers.                   |
| `lib/tools/questions.js` | `ask_user`: suspends the run until you reply.                        |
| `lib/tasklist.js`   | Oscar's own list for one run: what he decided to do, and where he has got to. |
| `lib/tools/checklist.js` | `plan_tasks` / `finish_task`: how that list gets made and ticked off. |
| `api/questions.js`  | Read what's waiting, answer it, and wake the run back up.                |
| `lib/db.js`         | Supabase logging over plain HTTPS. No-ops when unconfigured.              |
| `lib/tools/location.js` | Where am I / where is X. GPS, IP and geocoding.                       |
| `lib/tools/weather.js`  | Current conditions and forecast, via Open-Meteo.                      |
| `lib/tools/calendar.js` | Google Calendar: read the schedule, add events.                        |
| `lib/tools/tasks.js`    | Your Google Tasks to-do list: read, add, tick off.                      |
| `lib/tools/gmail.js`    | Gmail: search, read, draft, send. No delete, by design.                |
| `lib/google/auth.js`    | OAuth refresh-token exchange and the Google API wrapper.               |
| `lib/tools/plans.js`    | Your plans: goals broken into ordered steps you can tick off.          |
| `lib/plans.js`          | Plan storage in Supabase. Owned data, not someone else's API.          |
| `lib/tools/people.js`   | The people you know: save, look up, and forget one.                    |
| `lib/people.js`         | People storage in Supabase, and the rules for merging into a person.   |
| `lib/catch.js`          | Background catching: noticing the people you mention, without asking.  |
| `lib/settings.js`       | Settings that must hold everywhere — the Shortcut, jobs, the laptop.   |
| `api/settings.js`       | Read and change those settings. Session login only.                    |
| `lib/tools/index.js`    | Tool registry, and the write-permission gate.                          |
| `lib/tools/shell.js`    | `run_cmd` / `check_cmd`: commands queued for your own computer.        |
| `lib/commands.js`       | The command queue. Your laptop polls it; nothing ever calls in.        |
| `lib/shell-policy.js`   | What the runner will and will not execute. The security boundary.      |
| `api/runner.js`         | The one endpoint your laptop talks to. Its own secret, deliberately.   |
| `scripts/runner.js`     | The runner you start on your machine. `npm run runner`.                |
| `lib/push.js`           | Web push: VAPID, payload encryption, and the device list.              |
| `api/push.js`           | Subscribe, unsubscribe, send a test. Session login only.               |
| `public/sw.js`          | The service worker. Shows notifications when the page is closed.       |
| `public/manifest.json`  | Makes Oscar installable — required for notifications on iOS.           |
| `scripts/vapid-keys.js` | Generates the notification keypair. `npm run vapid`.                   |
| `scripts/google-auth.js`| One-time authorisation helper. `npm run google-auth`.                  |
| `db/schema.sql`     | The table, indexes and RLS lockdown. Paste into Supabase's SQL editor.    |
| `public/index.html` | Login screen and the four tabs: ask, jobs, history, settings.             |
| `public/styles.css` | All the styling.                                                          |
| `public/app.js`     | Login flow, the conversation, live job watching, browser dictation.       |
| `server.js`         | Optional local dev server — plain Node, no Vercel CLI needed.             |
| `test/smoke.js`     | Dependency-free tests, including the security rules. `npm test`.           |
| `SHORTCUT.md`       | **Step-by-step build of the iOS Shortcut.**                               |
| `ENV.md`            | **Every environment variable, and how to obtain each one.**               |
| `SUPABASE.md`       | **Setting up the database log.** Optional.                                |
| `TOOLS.md`          | **How the tools work, and how to add your own.**                          |
| `GOOGLE.md`         | **Connecting Gmail, Calendar, Tasks, Drive and Docs.** Includes the 7-day OAuth trap. |
| `RUNNER.md`         | **Letting Oscar run commands on your own computer.** Read before enabling it. |
| `PUSH.md`           | **Notifications on your phone.** Includes the iOS Home Screen trap.        |
| `MISSIONS.md`       | **Work that plans itself, then does itself.** Goal in, program out.        |
| `QUESTIONS.md`      | **When Oscar doesn't know.** Pausing to ask, and resuming on your answer.  |

## Setup

### 1. Get an OpenAI key

<https://platform.openai.com/api-keys>. Add a few dollars of credit — the
default model (`gpt-4o-mini`) costs a fraction of a cent per question, so $5
lasts a very long time at conversational volume.

### 2. Get an email sending key

Sign up at **[Resend](https://resend.com)** and make an API key. Their
`onboarding@resend.dev` sender delivers to your own account email with no domain
setup, so this takes about two minutes.

Postmark and SendGrid work too — set `POSTMARK_TOKEN` or `SENDGRID_API_KEY`
instead and `lib/mailer.js` picks up whichever it finds. If you set none of
them, the code is printed to your Vercel function logs, which is enough to sign
in and try everything before committing to a provider.

### 3. Deploy

```bash
npm i -g vercel
vercel login
vercel          # first deploy, creates the project
vercel --prod   # promote to your permanent URL
```

There is nothing to `npm install` — no runtime dependencies. Vercel serves
`public/` as the site root and turns each file in `api/` into a function.

### 4. Set environment variables

In **Vercel → your project → Settings → Environment Variables**:

| Name                  | Required | Value                                                       |
| --------------------- | :------: | ----------------------------------------------------------- |
| `OPENAI_API_KEY`      |    ✅    | your OpenAI key                                              |
| `OSCAR_PASSKEY`       |    ✅    | the password you'll type on the website                      |
| `OSCAR_OWNER_EMAIL`   |    ✅    | where sign-in codes get emailed                              |
| `OSCAR_SHARED_SECRET` |    ✅    | the Shortcut's credential — `openssl rand -hex 24`           |
| `OSCAR_SESSION_SECRET`|    ▲    | signs login sessions — `openssl rand -hex 32`                |
| `RESEND_API_KEY`      |    ▲    | (or `POSTMARK_TOKEN` / `SENDGRID_API_KEY`)                   |
| `OPENAI_MODEL`        |          | defaults to `gpt-4o-mini`                                    |
| `OSCAR_MAX_WORDS`     |          | answer length cap, default `60`                              |
| `OSCAR_PERSONA`       |          | standing instructions, see below                             |
| `OSCAR_PASSKEY_HASH`  |          | sha256 hex, instead of `OSCAR_PASSKEY`                       |

▲ = strongly recommended. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
for logging — see [SUPABASE.md](./SUPABASE.md).

**[ENV.md](./ENV.md) documents every variable in depth**, including step-by-step
instructions for obtaining each key and what breaks without it.

**Redeploy after adding them** (`vercel --prod`) — env vars are baked in at
deploy time.

Then open `https://your-app.vercel.app/api/health`. Everything under `auth`
should read `true`, and `mailProvider` should not say `"log"`. Add `?deep=1` to
also test the database connection once you've set it up.

### 5. Sign in and test

Open `https://your-app.vercel.app`, enter your password, then the code from your
email. The console behind the login calls the same endpoint your Shortcut will.
Debug here, not on the phone.

Four tabs, along the bottom:

| Tab          | What it is                                                                  |
| ------------ | --------------------------------------------------------------------------- |
| **Ask**      | The conversation. Follow-ups carry on from the answer before them, and Oscar's thinking sits underneath — the tasks he planned, ticking off as he finishes them. |
| **Jobs**     | Anything too heavy to answer on the end of a request, with its task list and how far through it is. Needs Supabase. |
| **History**  | Every exchange, grouped back into the conversations they happened in. Reopen one and carry on with it. Needs Supabase. |
| **Settings** | How much of the machinery you want to see, plus notifications and the Shortcut endpoint. |

**Detailed thinking** in Settings is the one worth knowing about. On, you get
every tool call and round as it happens; off, you get the task list alone —
plain sentences about what Oscar is doing. The model name and the round-trip
time can be hidden there too.

### 6. Build the Shortcut

Follow **[SHORTCUT.md](./SHORTCUT.md)** — four actions, about three minutes.

### 7. Optional: let it check the weather

Nothing to set up — the tools use free, keyless APIs and are on by default. Ask
"do I need a jacket?" and it will fetch real conditions. Add a **Get Current
Location** step to your Shortcut so it knows where you are; see
[TOOLS.md](./TOOLS.md).

### 8. Optional: connect Google

Gmail, Calendar, Tasks, Drive and Docs — "what's on my calendar?", "any mail
from Sam?", "find my lease agreement", "write that up as a doc",
"add milk to my list". Follow **[GOOGLE.md](./GOOGLE.md)**, and read the warning
at the top: an OAuth app left in "Testing" status stops working after exactly
7 days.

### 9. Optional: turn on logging

Follow **[SUPABASE.md](./SUPABASE.md)** — about ten minutes. You get a
searchable record of every question, real cost and latency numbers, and the
**History** and **Jobs** tabs in the console. Conversations need it too: the
earlier turns of a thread are read back out of this table, which is what makes
a follow-up question mean anything. Everything else works without it.

## Local development

```bash
cp .env.example .env.local   # fill in your keys
npm start                    # http://localhost:3000, plain Node
# or: vercel dev             # closer to production routing
npm test                     # no network, no keys needed
```

Use `http://localhost:3000` rather than your LAN IP — session cookies are
marked `Secure`, and browsers only keep those over HTTPS or on localhost.

`npm test` runs both handlers end to end against a fake OpenAI and a fake mail
provider, including the auth rules: forged tokens, expired sessions, replayed
challenges, wrong codes, CORS. Change anything security-relevant and run it.

---

## How the login works

Two callers, two credentials, because they have different constraints:

- **The website** uses a password plus a code emailed to you. Both are required;
  the password alone gets you nothing but an email.
- **The Shortcut** uses the `x-oscar-key` header. It has to — a Shortcut can't
  check your inbox for a code. Treat that secret as equivalent to the password:
  anyone holding it can spend your OpenAI credit, but they cannot get a website
  session with it.

There is **no database**. Both the mid-login challenge and the finished session
are HMAC-signed tokens: the server re-computes the signature with
`OSCAR_SESSION_SECRET` to verify them, so it doesn't need to have stored
anything. Specifically:

- The emailed code is never stored anywhere. The challenge token holds only an
  HMAC of it, so intercepting the token doesn't reveal the code.
- The challenge is bound to the browser that asked for it, so a stolen token
  can't be redeemed elsewhere.
- The session cookie is `HttpOnly` (page scripts can't read it, so an XSS bug
  can't steal it), `Secure`, and `SameSite=Lax` (not sent on cross-site
  requests, which is what stops CSRF).
- Codes are 6 characters from a 32-symbol alphabet with no ambiguous glyphs —
  about 1.07 billion combinations, valid for 10 minutes.
- CORS never reflects a foreign origin with credentials, so another website
  can't ride your session.

**Rotating a secret is your "log out everywhere" button.** Change
`OSCAR_SESSION_SECRET` and redeploy: every browser session dies instantly and
the Shortcut is unaffected. Change `OSCAR_SHARED_SECRET` and the Shortcut needs
its header updated.

### What this does not protect

Worth being straight about, since "only I can access it" is the goal:

- **The static page is public.** Hiding the console until you sign in is
  convenience. Anyone can read `index.html`, `app.js` and `styles.css` — they
  contain no secrets, and every route that does anything checks auth server-side.
- **`/api/health` is public** by design, reporting booleans only. It's what you
  need when you're locked out and trying to work out why.
- **Going stateless costs two things**: a code remains valid for its full
  10-minute window even after you've used it, and there's no lockout after N
  bad attempts. Guessing a code blind is ~1 in a billion per try and you'd need
  the password first, so this is a reasonable trade for a personal tool — but
  it *is* a trade.
- **Your email account is now part of your security.** Whoever can read your
  inbox can complete a login, given the password.

### Hardening further

- **True one-time codes and lockouts** need somewhere to record used codes and
  failed attempts. Add Vercel KV or Upstash Redis, store the challenge `jti` on
  use, and reject replays in `verifyChallenge`.
- **Face ID / Touch ID login** is the thing "passkey" usually means —
  [WebAuthn](https://webauthn.guide/) passkeys. It's a genuinely better fit for
  a personal tool than a password, and it would replace both factors here. It
  needs a place to store the credential's public key, so pair it with the KV
  step above.
- **Vercel's own protections** — Deployment Protection or Vercel Authentication
  in project settings — can put a second gate in front of the whole deployment,
  including static files, if you want the page itself hidden.
- **Rotate `OSCAR_SHARED_SECRET`** occasionally, since it lives in plain text
  inside a Shortcut on your phone.

---

## Tuning the agent

Everything about the agent's voice lives in `buildSystemPrompt()` in
`lib/agent.js`. The constraints there exist for notification-specific reasons:

- **Word cap** — iOS truncates a notification banner at roughly 3–4 lines.
- **No markdown** — asterisks and hashes render literally in a notification.
- **No "Great question!" openers** — you're reading this at a glance.
- **Expect transcription errors** — the input came from speech, not typing.

For per-user preferences use `OSCAR_PERSONA` rather than editing code, e.g.
`Answer in metric. I live in Seattle. I'm a software engineer, so skip basic explanations.`

## Cost

Vercel's free tier plus a cheap model makes this effectively free for personal
use. Resend and Supabase free tiers cover far more than a personal tool needs.
Once logging is on, `select sum(total_tokens) from conversations` tells you
exactly what you've spent instead of guessing.

## Where to take it next

- **Speak the answer** — feed the `speak` field into a **Speak Text** action so
  length stops mattering. Consider sending a `mode` field so the word cap
  relaxes when you're listening rather than glancing.
- **Learn about you** — extract durable facts from the `conversations` table on
  a schedule, store them, inject them into the prompt. See the end of
  [SUPABASE.md](./SUPABASE.md) for the shape, including the part everyone gets
  wrong (retiring facts that stop being true).
- **Conversation memory** — give the Shortcut a session id, store turns in
  the same database, prepend them in `askAgent`.
- **Tools** — add OpenAI function calling in `lib/agent.js` (web search, your
  calendar, a notes API) and loop until the model stops asking for tools.
- **Long-running answers** — if you add tools, replies can exceed what a
  Shortcut will politely wait for. Return a job id immediately, then push the
  real answer via [ntfy.sh](https://ntfy.sh) or Pushcut.
- **Follow-ups** — swap *Show Notification* for *Ask for Input* in a **Repeat**
  loop to get a back-and-forth conversation.
