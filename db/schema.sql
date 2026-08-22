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
--  Conversations, as in back-and-forths
--
--  Each row is still one exchange — a question and its answer. What this column
--  adds is which THREAD the exchange belongs to, so a follow-up ("and what
--  about tomorrow?") can be shown next to the turn it refers to, and read back
--  as context when Oscar answers it.
--
--  Null is a perfectly good value: a one-shot Shortcut question belongs to no
--  thread, and every row written before this column existed has none either.
--  Those are rendered as single-turn conversations rather than being hidden.
-- ---------------------------------------------------------------------------

alter table public.conversations add column if not exists conversation_id uuid;

-- Reading one thread, oldest first, is the whole access pattern.
create index if not exists conversations_thread_idx
  on public.conversations (conversation_id, created_at);


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

  -- queued | running | awaiting_confirm | awaiting_answer
  --   | done       — answered, with every task on its list ticked off
  --   | incomplete — answered, but it stopped with tasks still open
  --   | failed | cancelled
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

-- Added with the task list and conversation threading. Both are safe to run
-- again on an existing database.
--
--   tasks            what Oscar decided to do, and how far through it he is:
--                    [{n, title, done, note}, ...]. Kept on the job rather than
--                    inside `state` because `state` is deliberately thrown away
--                    when a job finishes, while the list of what was done is
--                    worth keeping. See lib/tasklist.js.
--   conversation_id  which back-and-forth started this job, so its answer lands
--                    in the right thread in History when it eventually arrives.
alter table public.jobs add column if not exists tasks jsonb not null default '[]'::jsonb;
alter table public.jobs add column if not exists conversation_id uuid;

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


-- ============================================================================
--  COMMANDS — the bridge to your own computer
--
--  Oscar runs on Vercel. Your laptop sits behind NAT with no inbound port, so
--  the server can never reach INTO it. The direction is therefore inverted:
--  this table is a mailbox, and a small local runner (scripts/runner.js) polls
--  it outward, claims work, and posts the result back.
--
--  Same baton pattern as `jobs` — nothing has to stay connected, and the laptop
--  can be shut, asleep or offline without anything breaking. Commands simply
--  wait, and expire if nobody ever collects them.
--
--  SECURITY NOTE. A row here is a request, never an authorisation. The runner
--  on the laptop applies its own allowlist and refuses anything it dislikes,
--  regardless of what this table says. That is deliberate: if the deployment or
--  this database were ever compromised, the laptop still says no.
-- ============================================================================

create table if not exists public.commands (
  id           uuid        primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  finished_at  timestamptz,

  -- queued | claimed | done | failed | refused | expired
  status       text        not null default 'queued',

  -- what was asked for
  command      text        not null,
  cwd          text,                          -- null means the runner's default
  timeout_ms   integer     not null default 30000,
  reason       text,                          -- why the agent wanted to run it

  -- what came back
  exit_code    integer,
  stdout       text,
  stderr       text,
  error        text,                          -- transport/refusal message

  -- provenance
  runner       text,                          -- hostname that claimed it
  job_id       uuid,                          -- set when a background job asked
  via          text                           -- 'session' | 'write-key'
);

comment on table public.commands is
  'Shell commands queued for the local runner on your own machine.';

-- The runner's only read pattern: oldest queued first.
create index if not exists commands_queued_idx
  on public.commands (status, created_at);

create index if not exists commands_created_idx
  on public.commands (created_at desc);

alter table public.commands enable row level security;
revoke all on public.commands from anon, authenticated;

-- Anything nobody collected within ten minutes is stale — the laptop was off.
-- Run occasionally, or schedule with pg_cron:
--
--   update public.commands set status = 'expired', finished_at = now()
--   where status = 'queued' and created_at < now() - interval '10 minutes';

-- What has run lately:
--   select created_at, status, exit_code, command from public.commands
--   order by created_at desc limit 50;


-- ============================================================================
--  PUSH SUBSCRIPTIONS — notifications to the phone
--
--  One row per browser that has agreed to receive notifications. The endpoint
--  is issued by the browser's own push service (Apple, Google, Mozilla), and
--  the two keys are what let the server encrypt a payload that ONLY that
--  browser can read — the push service relays it without being able to see it.
--
--  The endpoint doubles as the identity: re-subscribing the same browser
--  returns the same endpoint, so it is the natural unique key.
--
--  These rows are credentials for talking TO your devices, not for reading
--  anything, but they are still worth the same RLS lockdown as everything else.
-- ============================================================================

create table if not exists public.push_subscriptions (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,

  endpoint     text        not null unique,
  p256dh       text        not null,         -- the browser's public key
  auth         text        not null,         -- the shared auth secret

  label        text,                         -- "iPhone", from the user agent
  -- Push services return 404/410 for a subscription that is gone for good.
  -- Rather than delete immediately we mark it, so a flaky day doesn't silently
  -- unsubscribe every device you own.
  failures     integer     not null default 0,
  expired_at   timestamptz
);

comment on table public.push_subscriptions is
  'Browsers that have agreed to receive notifications from Oscar.';

create index if not exists push_subscriptions_live_idx
  on public.push_subscriptions (expired_at, created_at desc);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- Which devices are live:
--   select label, created_at, last_used_at, failures from public.push_subscriptions
--   where expired_at is null order by created_at desc;

-- Forget the dead ones:
--   delete from public.push_subscriptions where expired_at is not null;


-- ============================================================================
--  QUESTIONS — Oscar asking YOU something
--
--  The inverse of everything else here. When a run hits something it cannot
--  decide — which framework, which of two files you meant, whether a guess is
--  right — it writes a row here, notifies you, and goes to sleep. Answering it
--  wakes the run up exactly where it stopped.
--
--  WHY THIS IS A TABLE AND NOT JUST A FIELD ON `jobs`
--
--  Because the question outlives the attempt to answer it. You get the
--  notification on a bus, answer it three hours later from a laptop, and the
--  job resumes. It also means the website can greet you with everything Oscar
--  is currently wondering about, across every run, in one list.
-- ============================================================================

create table if not exists public.questions (
  id           uuid        primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  answered_at  timestamptz,

  -- pending | answered | cancelled | expired
  status       text        not null default 'pending',

  question     text        not null,
  -- Optional multiple choice. The web app renders these as buttons, which is
  -- the difference between answering on a phone and not bothering.
  options      jsonb,
  -- Why it is asking, shown underneath. Usually one line.
  context      text,

  answer       text,

  -- The run waiting on this. Null for a question asked outside a job.
  job_id       uuid
);

comment on table public.questions is
  'Things Oscar has stopped to ask you, and your answers.';

create index if not exists questions_pending_idx
  on public.questions (status, created_at desc);

create index if not exists questions_job_idx
  on public.questions (job_id);

alter table public.questions enable row level security;
revoke all on public.questions from anon, authenticated;

-- What is Oscar waiting on right now:
--   select created_at, question, job_id from public.questions
--   where status = 'pending' order by created_at desc;

-- Anything unanswered for a week is not going to be answered:
--   update public.questions set status = 'expired'
--   where status = 'pending' and created_at < now() - interval '7 days';

-- Jobs gained a pointer to the question they are waiting on. Safe to re-run;
-- this is why you can paste this whole file again rather than diffing it.
alter table public.jobs add column if not exists question_id uuid;

-- What is parked waiting on you, with the question itself:
--   select j.id, q.question, q.created_at
--   from public.jobs j join public.questions q on q.id = j.question_id
--   where j.status = 'awaiting_answer';



-- ============================================================================
--  SETTINGS — the choices that have to be true everywhere
--
--  Most of Oscar's settings live in your browser, because they only change what
--  the screen shows. This table is for the other kind: a choice that also has to
--  hold for a Shortcut on your phone, for a job running on a server while you
--  sleep, and for the laptop polling for commands. None of those can read
--  localStorage, so the answer is written down here instead.
--
--  One row per setting, keyed by name:
--
--    command_policy       "off" | "confirm" | "destructive" | "open"
--                         whether Oscar may run commands on your computer at
--                         all, and whether each one asks first. Read by the
--                         shell tool before queueing and by /api/runner on
--                         every claim, so changing it takes effect within a
--                         few seconds without restarting the runner.
--                         Defaults to "destructive", and every failure path
--                         lands there too: an unreadable answer must not be
--                         the thing that lets commands run unattended.
--
--                         This absorbed two earlier settings on 2026-08-21,
--                         `confirm_level` and `notification_level`, which
--                         asked the same question and were read by nothing.
--                         Old rows for either key are simply ignored; delete
--                         them with the statement at the bottom if you like a
--                         tidy table.
--
--    background_catching  true | false, and false unless you say otherwise
--                         whether Oscar quietly records the people you mention
--                         into `people` as you talk, rather than only when you
--                         ask him to. Off by default because it collects
--                         information about other people rather than about you,
--                         and that should be a decision you made on purpose.
--                         See lib/catch.js.
--
--  jsonb rather than text so the next setting can be an object without a
--  migration. Reading it is on the critical path of every tool call, so the
--  table is deliberately tiny and read by primary key.
-- ============================================================================

create table if not exists public.settings (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

comment on table public.settings is
  'Server-side preferences, keyed by name. Read by the API, the agent and the runner.';

alter table public.settings enable row level security;
revoke all on public.settings from anon, authenticated;

-- What is Oscar currently set to ask about:
--   select key, value, updated_at from public.settings;

-- Stop Oscar touching the computer, without opening the website:
--   insert into public.settings (key, value) values ('command_policy', '"off"')
--   on conflict (key) do update set value = excluded.value, updated_at = now();

-- Set it from here rather than the website, if you would rather:
--   insert into public.settings (key, value) values ('command_policy', '"open"')
--   on conflict (key) do update set value = excluded.value, updated_at = now();

-- Clear out the two settings that were folded into command_policy. Optional:
-- nothing reads them, so leaving them costs two rows and no behaviour.
--   delete from public.settings where key in ('confirm_level', 'notification_level');

-- Turn passive contact-catching on without touching the website:
--   insert into public.settings (key, value) values ('background_catching', 'true')
--   on conflict (key) do update set value = excluded.value, updated_at = now();

-- ============================================================================
--  PEOPLE — the address book Oscar fills in himself
--
--  Everything else Oscar stores is something you asked him to store. This table
--  is different: most of it arrives as a side effect of ordinary conversation.
--  You say "I'm writing to my sister Olivia" because you want help writing to
--  her, not because you wanted a contact record — and yet the useful thing to
--  do with that sentence is remember that Olivia is your sister, so the next
--  time you mention her Oscar already knows.
--
--  That behaviour is OFF until you turn it on. See the `background_catching`
--  setting below. With it off this table still works perfectly well; it just
--  only ever holds what you explicitly asked to be saved.
--
--  WHAT BELONGS IN HERE, AND WHAT VERY MUCH DOES NOT
--
--  Durable facts about a person: how you know them, how to reach them, where
--  they work, when their birthday is. NOT how they are today. "Olivia has a
--  cold" is true for a week and then actively misleading, and an assistant that
--  brings up a cold from last March is worse than one that never listened.
--  lib/catch.js is where that line is drawn and it is the most important rule
--  in the feature.
--
--  ONE ROW PER NAME. `name` is what you actually call them — "Olivia", not
--  "Olivia Margaret Stall" — because that is the word you will say when you
--  want her back out again. The unique index below is what makes "add this to
--  Olivia" a merge rather than a second Olivia, and it is enforced here rather
--  than hoped for in application code, so two mentions racing each other cannot
--  produce a duplicate. Genuinely two Olivias? The second one gets a
--  distinguishing name — "Olivia Chen" — which is what you would say out loud
--  anyway once one Olivia was ambiguous.
-- ============================================================================

create table if not exists public.people (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- What you call them. The handle, not the legal name.
  name         text        not null,
  full_name    text,

  -- "sister", "my boss at Acme", "friend from university". Free text on
  -- purpose: an enum of relationships is a taxonomy nobody's actual life fits.
  relationship text,

  -- Arrays because people have a work address and a personal one, and because
  -- learning a second phone number should not overwrite the first. Merged as a
  -- union — see mergePerson() in lib/people.js.
  emails       text[]      not null default '{}',
  phones       text[]      not null default '{}',

  -- Text, not date. "March 4th" and "the 12th of some month in summer" are both
  -- real answers people give, and a date column would force Oscar to invent a
  -- year in order to store either of them.
  birthday     text,

  company      text,
  role         text,
  location     text,

  -- Everything else worth keeping, one fact per element. An array rather than a
  -- paragraph so adding a fact is an append and de-duplicating is an equality
  -- check, instead of string surgery on prose.
  notes        text[]      not null default '{}',

  -- ---- provenance --------------------------------------------------------
  -- 'explicit'   you asked for this person to be saved.
  -- 'background' Oscar picked them up from something you said in passing.
  --
  -- Worth a column because the two deserve different trust: a background fact
  -- may fill a gap but may never overwrite something you stated directly, and
  -- when you ask "where did that come from" the answer should exist. A row that
  -- starts background and is later confirmed by you becomes explicit; it never
  -- travels the other way.
  source       text        not null default 'explicit',

  -- How often they have come up, and when they last did. Cheap to maintain and
  -- it is what makes "who do I talk about most" answerable later.
  mentions     integer     not null default 1,
  last_seen_at timestamptz not null default now()
);

comment on table public.people is
  'People you know: how you know them, and how to reach them. Filled in explicitly, and passively when background catching is on.';

-- The merge invariant, enforced by the database rather than by hope. Case
-- folded because you will say "olivia" as often as "Olivia".
create unique index if not exists people_name_key
  on public.people (lower(name));

-- "Who do I know" is read newest-mentioned first: the people currently in your
-- life, not the ones you entered first.
create index if not exists people_last_seen_idx
  on public.people (last_seen_at desc);

-- Fuzzy lookup for "my sister", "that guy at Acme". pg_trgm is already enabled
-- further up this file for the history search.
create index if not exists people_name_trgm_idx
  on public.people using gin (name gin_trgm_ops);

create index if not exists people_relationship_trgm_idx
  on public.people using gin (relationship gin_trgm_ops);


-- ---------------------------------------------------------------------------
--  Row Level Security — same reasoning as every other table here, and with the
--  sharpest edge of any of them. This is the only table that holds other
--  people's contact details, which are not yours to leak. RLS on, no policies:
--  the anon key gets nothing, and only the service role key that lives in your
--  Vercel environment can read a single row.
-- ---------------------------------------------------------------------------

alter table public.people enable row level security;

revoke all on public.people from anon, authenticated;


-- ---------------------------------------------------------------------------
--  Handy people queries
-- ---------------------------------------------------------------------------

-- Who Oscar knows about:
--   select name, relationship, emails, mentions, last_seen_at
--   from public.people order by last_seen_at desc;

-- What was picked up passively rather than told to him directly:
--   select name, relationship, notes, created_at from public.people
--   where source = 'background' order by created_at desc;

-- Second thoughts about background catching? This forgets everything it ever
-- collected on its own, and keeps everything you asked for:
--   delete from public.people where source = 'background';


-- ============================================================================
--  MCP SERVERS — the tools Oscar was not shipped with
--
--  Every other capability in this system was decided by whoever wrote the code.
--  A row in this table is a capability decided by whoever is using it: point
--  Oscar at a Model Context Protocol server on the settings page and its tools
--  become his tools, with no deploy and no code change.
--
--  THE `access` COLUMN IS THE SECURITY MODEL. EVERYTHING ELSE HERE IS PLUMBING.
--
--  Built-in tools are hand-labelled by someone who read what they do, and that
--  labelling is what stops the read-only "Ask Oscar" Shortcut from sending mail
--  or touching the laptop. A tool discovered over MCP arrives with none of it.
--  MCP servers may declare annotations — readOnlyHint, destructiveHint — but
--  they are declared by the server being gated, so Oscar records them, shows
--  them to you, and decides nothing by them.
--
--  What decides is this column: one level per tool, chosen by you.
--
--    off    Withheld. The model is never told the tool exists. THE DEFAULT for
--           every newly discovered tool — connecting a server grants nothing.
--    ask    Offered, needs write authority, every call read back to you first.
--    read   Offered to everything including the Shortcut, no confirmation.
--           Only for tools you have checked cannot change anything.
--    open   Offered with write authority, no confirmation. Acts immediately.
--
--  A refresh MERGES rather than replaces: a tool you set to `read` last week
--  stays `read` when its description changes, and a tool that has appeared
--  since arrives at `off` like any other new one. So a server cannot widen its
--  own permissions by adding a tool and waiting for you to press Refresh.
--
--  `token` IS A CREDENTIAL AND NEVER LEAVES THE SERVER. /api/mcp reports
--  `hasToken: true` and offers to replace it; there is no path that reads it
--  back out. RLS below is what makes that stick.
-- ============================================================================

create table if not exists public.mcp_servers (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- What you call it — "Linear", "my notes server". The slug is derived from
  -- it once, at creation, and is what prefixes every tool name this server
  -- contributes: `linear__create_issue`. Prefixing is not cosmetic. OpenAI tool
  -- names have to be unique across the whole list, and nothing stops a remote
  -- server from naming its tool `send_email` and shadowing yours.
  label        text        not null,
  slug         text        not null,

  -- The streamable-HTTP endpoint. https, or http on localhost. See
  -- lib/mcp/client.js — the older SSE transport and stdio are not supported.
  url          text        not null,

  -- Bearer token, if the server wants one. Server-side only, always.
  token        text,

  -- Off switch for the whole server, so you can silence one without losing the
  -- per-tool decisions you made about it.
  enabled      boolean     not null default true,

  -- The last tools/list response, trimmed: name, description, input schema,
  -- annotations. Cached rather than fetched per request because otherwise every
  -- question you asked would begin with a handshake to every connected server.
  tools        jsonb       not null default '[]',

  -- { "<tool name>": "off" | "ask" | "read" | "open" }. See the header.
  access       jsonb       not null default '{}',

  -- What the server calls itself in its initialize response. Display only.
  server_name  text,

  refreshed_at timestamptz,

  -- Why the last refresh failed, or null. What lets the settings page say "this
  -- stopped answering on Tuesday" rather than showing an empty tool list and
  -- letting you assume the server has nothing to offer.
  last_error   text
);

comment on table public.mcp_servers is
  'MCP servers connected from the settings page, and how far each of their tools is trusted.';

-- One server per name. The slug is what tool names are built from, so two
-- servers sharing one would produce two different tools with the same name —
-- enforced here rather than hoped for in application code.
create unique index if not exists mcp_servers_slug_idx
  on public.mcp_servers (slug);

-- ---------------------------------------------------------------------------
--  Row Level Security — the same rule as every other table here, and this one
--  holds bearer tokens for third-party services. RLS on, no policies: the anon
--  key gets nothing, and only the service role key in your Vercel environment
--  can read a row.
-- ---------------------------------------------------------------------------

alter table public.mcp_servers enable row level security;

revoke all on public.mcp_servers from anon, authenticated;

-- ---------------------------------------------------------------------------
--  Handy MCP queries
-- ---------------------------------------------------------------------------

-- What Oscar is currently allowed to do beyond his built-in tools:
--   select label, key as tool, value as access
--   from public.mcp_servers, jsonb_each_text(access)
--   where enabled and value <> 'off' order by label, tool;

-- Panic switch for one server, without opening the website:
--   update public.mcp_servers set enabled = false where label = 'Linear';

-- Panic switch for all of them. Note this leaves your per-tool decisions
-- intact, so turning them back on does not mean setting them all up again:
--   update public.mcp_servers set enabled = false;

-- Take everything back to withheld without disconnecting anything:
--   update public.mcp_servers
--   set access = (select jsonb_object_agg(key, '"off"'::jsonb) from jsonb_each(access));
