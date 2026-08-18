-- ============================================================================
--  Oscar — database schema
--  Paste this whole file into Supabase → SQL Editor → New query → Run.
--  It is safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  conversations
--
--  One row per question asked, whether it succeeded or failed. Failures are
--  logged too — a table that only records successes hides exactly the
--  information you need when something breaks.
-- ---------------------------------------------------------------------------

create table if not exists public.conversations (
  id           bigint generated always as identity primary key,
  created_at   timestamptz  not null default now(),

  -- what was asked
  question     text         not null,
  time_zone    text,

  -- what came back
  answer       text,
  detail       text,
  title        text,

  -- how it went
  ok           boolean      not null default true,
  error        text,                          -- null when ok
  status       integer,                       -- HTTP status returned to the caller

  -- provenance
  model        text,
  via          text,                          -- 'key' (Shortcut) or 'session' (browser)
  source       text,                          -- 'shortcut' | 'console' | other

  -- which tools ran, e.g. {get_location,get_weather}. Names only: tool RESULTS
  -- can contain your coordinates, so they are deliberately not stored.
  tools_used   text[],

  -- performance and cost
  elapsed_ms   integer,                       -- time inside the model call
  total_ms     integer,                       -- time for the whole request
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer
);

comment on table public.conversations is
  'Every question asked of Oscar, successful or not.';

-- Newest-first listing is the only read pattern the app has, so this is the
-- one index that earns its keep.
create index if not exists conversations_created_at_idx
  on public.conversations (created_at desc);

-- Supports the history search box. pg_trgm makes ILIKE '%term%' fast enough
-- that you never think about it; without it, search degrades into a full scan
-- once the table is large.
create extension if not exists pg_trgm;

create index if not exists conversations_question_trgm_idx
  on public.conversations using gin (question gin_trgm_ops);


-- Added after the first release. Safe to run on an existing table — this is why
-- you can paste this whole file again rather than hunting for what changed.
alter table public.conversations add column if not exists tools_used text[];


-- ---------------------------------------------------------------------------
--  Row Level Security
--
--  This is the important part, so it is worth being explicit about what is
--  happening.
--
--  Supabase gives every project a public "anon" key that is designed to be
--  embedded in browsers, and RLS is what stops that key reading your data.
--  Oscar never uses the anon key at all — the server holds the SERVICE ROLE
--  key, which bypasses RLS entirely by design.
--
--  So: enabling RLS with NO policies means the anon key can do nothing, while
--  Oscar's server keeps full access. That is exactly what we want. If this
--  table were ever exposed through the anon key by accident, it would return
--  nothing rather than your entire question history.
-- ---------------------------------------------------------------------------

alter table public.conversations enable row level security;

-- Deliberately no policies are created. Anything using the anon or an
-- authenticated user key gets zero rows. Only the service role key — which
-- lives solely in your Vercel environment variables — can read or write.

-- Belt and braces: revoke the default grants Supabase hands to those roles.
revoke all on public.conversations from anon, authenticated;


-- ---------------------------------------------------------------------------
--  Housekeeping (optional)
--
--  Uncomment if you'd rather the log not grow forever. Requires pg_cron, which
--  you enable under Database → Extensions.
-- ---------------------------------------------------------------------------

-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'oscar-prune-conversations',
--   '0 4 * * *',                       -- 04:00 UTC daily
--   $$ delete from public.conversations where created_at < now() - interval '180 days' $$
-- );


-- ---------------------------------------------------------------------------
--  Handy queries for the Supabase SQL editor
-- ---------------------------------------------------------------------------

-- Recent activity:
--   select created_at, question, answer, total_ms from public.conversations
--   order by created_at desc limit 50;

-- What is this costing me, by day:
--   select date_trunc('day', created_at) as day,
--          count(*) as questions,
--          sum(total_tokens) as tokens,
--          round(avg(total_ms)) as avg_ms
--   from public.conversations
--   group by 1 order by 1 desc;

-- Everything that went wrong:
--   select created_at, status, error, question from public.conversations
--   where not ok order by created_at desc;

-- Phone vs browser:
--   select via, count(*) from public.conversations group by via;

-- Which tools actually get used:
--   select unnest(tools_used) as tool, count(*)
--   from public.conversations where tools_used is not null
--   group by 1 order by 2 desc;


-- ============================================================================
--  PLANS
--
--  Added in the plans release. Safe to run on an existing database — every
--  statement below is idempotent, which is why you can paste this whole file
--  again rather than hunting for what changed.
--
--  A plan is a goal broken into ordered steps you can tick off individually.
--  Two tables rather than one JSON blob, because "mark step 2 done" should be
--  a single UPDATE, not a read-modify-write of the whole plan.
-- ============================================================================

create table if not exists public.plans (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  title        text        not null,
  goal         text,                          -- what you actually want to achieve
  notes        text,

  -- active | done | archived. Kept as text rather than an enum so adding a
  -- state later doesn't need a migration.
  status       text        not null default 'active',
  due          date
);

comment on table public.plans is 'Goals broken into ordered steps.';

create index if not exists plans_status_idx
  on public.plans (status, created_at desc);

-- Lets "my move plan" match a plan titled "Moving to Seattle" without an exact
-- string. pg_trgm is already enabled above for the history search.
create index if not exists plans_title_trgm_idx
  on public.plans using gin (title gin_trgm_ops);


create table if not exists public.plan_steps (
  id           bigint generated always as identity primary key,
  plan_id      bigint      not null references public.plans(id) on delete cascade,

  -- 1-based, and what you say out loud: "mark step 2 done". NOT the row id.
  -- Deliberately not called "position" — that's a SQL function name, and the
  -- ambiguity is not worth the elegance.
  step_number  integer     not null,

  title        text        not null,
  notes        text,
  done         boolean     not null default false,
  done_at      timestamptz
);

create index if not exists plan_steps_plan_idx
  on public.plan_steps (plan_id, step_number);

-- Deleting a plan removes its steps (on delete cascade above), so there are no
-- orphans to clean up.


-- ---------------------------------------------------------------------------
--  Row Level Security — same reasoning as conversations.
--  RLS on, no policies: the anon key can do nothing, the service role key that
--  lives only in Vercel keeps full access.
-- ---------------------------------------------------------------------------

alter table public.plans      enable row level security;
alter table public.plan_steps enable row level security;

revoke all on public.plans      from anon, authenticated;
revoke all on public.plan_steps from anon, authenticated;


-- ---------------------------------------------------------------------------
--  Handy plan queries
-- ---------------------------------------------------------------------------

-- Everything on the go, with progress:
--   select p.title, p.due,
--          count(s.*) filter (where s.done) || '/' || count(s.*) as progress
--   from public.plans p left join public.plan_steps s on s.plan_id = p.id
--   where p.status = 'active'
--   group by p.id order by p.due nulls last;

-- The next thing to do on every active plan:
--   select distinct on (p.id) p.title, s.step_number, s.title
--   from public.plans p join public.plan_steps s on s.plan_id = p.id
--   where p.status = 'active' and not s.done
--   order by p.id, s.step_number;


-- ============================================================================
--  JOBS — asynchronous agent runs
--
--  A job is one agent run that outlives a single HTTP request. The Shortcut
--  creates one and returns immediately; the work continues across as many
--  serverless invocations as it needs, checkpointing here between steps.
--
--  This is what removes the 60-second ceiling. Vercel's waitUntil shares the
--  function's own timeout, so a single invocation can never run long. But each
--  NEW invocation gets a fresh budget — so the loop is spread across several,
--  with `state` carrying everything from one to the next.
-- ============================================================================

create table if not exists public.jobs (
  id           uuid        primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz,

  -- queued | running | awaiting_confirm | done | failed | cancelled
  status       text        not null default 'queued',

  question     text        not null,
  mode         text,                          -- 'fast' | 'deep', from the router
  model        text,

  -- The serialised agent state from createAgentState(). Everything needed to
  -- resume: messages, tool history, budgets spent. See lib/agent.js.
  state        jsonb,

  -- A readable trace the web app renders live: [{round, tool, ok}, ...]
  events       jsonb       not null default '[]'::jsonb,

  -- Output
  title        text,
  answer       text,
  detail       text,
  error        text,

  -- Set when a destructive tool wants a yes/no. The web app shows buttons.
  pending_confirm jsonb,

  steps        integer     not null default 0,
  total_tokens integer,
  source       text,
  via          text
);

comment on table public.jobs is
  'Asynchronous agent runs, checkpointed between serverless invocations.';

create index if not exists jobs_status_idx  on public.jobs (status, created_at desc);
create index if not exists jobs_created_idx on public.jobs (created_at desc);

alter table public.jobs enable row level security;
revoke all on public.jobs from anon, authenticated;

-- Housekeeping: `state` holds the full message history, which can be tens of
-- kilobytes per job. Clearing it on finished jobs keeps the table small while
-- preserving the answer. Run occasionally, or schedule with pg_cron.
--
--   update public.jobs set state = null
--   where status in ('done','failed') and updated_at < now() - interval '2 days';

-- What is still running:
--   select id, status, steps, question, updated_at from public.jobs
--   where status in ('queued','running','awaiting_confirm') order by created_at desc;

-- Fast vs deep, and what each costs:
--   select mode, count(*), round(avg(total_tokens)) as avg_tokens,
--          round(avg(extract(epoch from (finished_at - created_at)))) as avg_seconds
--   from public.jobs where finished_at is not null group by mode;
