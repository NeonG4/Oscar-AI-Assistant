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
