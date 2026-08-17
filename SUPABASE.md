# Setting up Supabase logging

Every question you ask Oscar gets written to a database table — what you asked,
what it answered, which model, how long it took, how many tokens it burned, and
whether it failed. You can browse it in the **History** tab of the web console.

This takes about ten minutes. Oscar works fine without it; skip this file and
nothing breaks, you just don't get a log.

**Why bother:** you get a searchable record of everything you've asked, real
cost and latency numbers instead of guesses, and visibility into failures that
otherwise vanish. It's also the foundation the "learn about me" feature would
build on — a profile has to be extracted from *something*, and this is it.

---

## 1. Create the project

1. Go to <https://supabase.com> and sign in (GitHub login is quickest).
2. **New project**.
   - **Name:** `oscar`
   - **Database password:** generate one and save it in your password manager.
     You won't need it for Oscar — it's for direct Postgres connections — but
     it's painful to reset later.
   - **Region:** pick the one closest to your Vercel deployment. This is a real
     latency decision: your function awaits the insert, so a database on another
     continent adds a round trip you'll feel on every question. If you're in the
     US and deploying to Vercel's default, `East US` or `West US` is right.
3. Wait a minute or two while it provisions.

> **Free tier note:** Supabase pauses free projects after about a week of
> complete inactivity. Daily use keeps it awake; if you stop using Oscar for a
> couple of weeks, the first request after that may fail while it wakes up.
> Unpause from the dashboard.

## 2. Create the table

1. Left sidebar → **SQL Editor** → **New query**.
2. Open `db/schema.sql` from this repo, copy the whole file, paste it in.
3. **Run**.

You should see "Success. No rows returned." Check **Table Editor** and you'll
see a `conversations` table with no rows yet.

The script is safe to run more than once, so if you're unsure whether it worked,
just run it again.

### What that script did

- Created `conversations` with columns for the question, answer, model, timing,
  token counts, and error details.
- Added an index on `created_at` (the History tab lists newest first) and a
  trigram index on `question` (so the search box stays fast as the table grows).
- **Enabled Row Level Security with no policies.** This is the security-relevant
  part, explained below.

## 3. Get the credentials

1. Left sidebar → **Project Settings** (gear icon) → **API**.
2. Copy the **Project URL** — looks like `https://abcdefghijkl.supabase.co`.
3. Scroll to **Project API keys** and copy the **`service_role`** key.
   It's hidden behind a "Reveal" button, and it's a long JWT.

> ### Read this before copying the service_role key
>
> Supabase gives you two keys. The **anon** key is designed to be public and
> embedded in browsers. The **service_role** key **bypasses Row Level Security
> completely** — anyone holding it has full read and write access to your entire
> database, regardless of any policy.
>
> Oscar uses the service_role key, on the server only. That is a deliberate
> choice: it means the `conversations` table can stay locked to everyone else.
>
> It follows that this key must **never** appear in `public/`, never be sent to
> a browser, and never be committed to git. Treat it exactly like your OpenAI
> key. If it leaks, rotate it immediately (Project Settings → API → Reset).

## 4. Tell Vercel about it

Vercel → your project → **Settings → Environment Variables**. Add:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | the Project URL from step 3 |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key from step 3 |

Tick Production, Preview and Development. Then **redeploy** — env vars are only
read at deploy time:

```bash
vercel --prod
```

## 5. Confirm it works

Open `https://your-app.vercel.app/api/health?deep=1`. Look for:

```json
"database": { "configured": true, "reachable": true }
```

`?deep=1` makes a real query against the table, so `reachable: true` proves the
URL, the key, *and* the table all exist. Without `?deep=1` the endpoint only
reports whether the variables are set, which is cheaper but proves less.

Then ask a question in the console and open the **History** tab. Your question
should be there.

---

## How it behaves

**Logging can never break an answer.** Every database call in `lib/db.js`
swallows its own errors and reports failure through a return value. If Supabase
is down, paused, or misconfigured, you still get your answer — the row is just
lost and the failure is written to your Vercel logs. There's a test for this
(`a database outage still returns the answer`), because a logging layer that can
take down the thing it's logging is worse than no logging at all.

**Failures are logged too.** A table that only records successes hides exactly
the information you need when something breaks. Failed rows have `ok = false`,
the HTTP status, and the error text.

**Unauthenticated requests are not logged.** Otherwise anyone who found your URL
could fill your database for free.

**The insert is awaited.** It adds roughly 50–150ms to a request that already
takes several seconds. The alternative — firing it off without waiting — sounds
faster but loses rows unpredictably: on serverless, the function can be frozen
the instant a response is sent, killing any in-flight request. If that 100ms
ever matters to you, the fix is Vercel's `waitUntil`, which costs one npm
dependency.

**History requires a full login.** `/api/history` accepts only a session cookie,
never the `x-oscar-key` header. That key sits in plain text inside a Shortcut on
your phone, which makes it the weaker credential — fine for asking a question,
not fine for reading back everything you've ever asked.

---

## Useful queries

Supabase → **SQL Editor**. A few to start with (more at the bottom of
`db/schema.sql`):

```sql
-- What is this costing me, by day?
select date_trunc('day', created_at) as day,
       count(*) as questions,
       sum(total_tokens) as tokens,
       round(avg(total_ms)) as avg_ms
from conversations
group by 1 order by 1 desc;

-- Everything that went wrong
select created_at, status, error, question
from conversations where not ok
order by created_at desc;

-- Phone vs browser
select source, count(*) from conversations group by source;

-- Slowest answers
select question, total_ms, model from conversations
where ok order by total_ms desc limit 20;
```

To convert tokens into actual dollars, multiply by the rates at
<https://openai.com/api/pricing> for whichever model you're using.

---

## Privacy, plainly

You are now keeping a permanent, searchable record of everything you ask. That's
the point — but it's worth deciding deliberately rather than discovering it
later.

- The table is locked down (RLS on, no policies, grants revoked from the `anon`
  and `authenticated` roles), so only your service_role key can read it. But
  Supabase staff, like any database host, have operational access to the
  underlying infrastructure.
- If you ask Oscar something sensitive, it's in there.
- There's no delete UI. Remove rows from the Supabase table editor, or:
  `delete from conversations where id = 123;`
- To cap retention automatically, uncomment the `pg_cron` block at the bottom of
  `db/schema.sql` — it prunes anything older than 180 days.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `"configured": false` | Variables not set, or you didn't redeploy |
| `"reachable": false` with a 404 | Table doesn't exist — run `db/schema.sql` |
| `"reachable": false` with a 401 | Wrong key. Make sure you copied `service_role`, not `anon` |
| History tab says "No database configured" | Same as `configured: false` |
| Answers work but nothing is logged | Check Vercel → Logs for `could not log to supabase` |
| Everything times out after a break | Free project auto-paused. Unpause in the dashboard |
| Rows appear but `total_tokens` is null | Some model responses omit usage data; harmless |

---

## What this unlocks next

With a log table in place, the "learn about me" feature becomes tractable. The
shape would be:

1. A `profile_facts` table holding durable statements about you ("high school
   student", "prefers metric").
2. A scheduled job that reads new `conversations` rows and asks a cheap model
   whether anything durable was revealed — kept off the critical path so your
   notification latency doesn't change.
3. Those facts injected into the system prompt on each question. At this scale
   you load all of them; embeddings and vector search are unnecessary until you
   have hundreds.

The hard part isn't storing facts, it's retiring them — "I'm in high school"
becomes wrong eventually, and a profile that only accumulates will quietly start
poisoning answers. Any implementation needs supersede logic and a way to say
"forget that".
