# When Oscar doesn't know

Halfway through building something, Oscar hits a choice it can't make for you.
Rather than guessing, it writes the question down, notifies you, and goes to
sleep. Your answer wakes it up exactly where it stopped.

---

## Why a run should be able to stop and ask

The alternative is bad in both directions.

A model that **never asks** guesses — and a confident wrong guess ten steps into
a mission wastes everything built on top of it. A model that **asks constantly**
is a chat window with extra latency and a notification you've learned to ignore.

So `ask_user` is deliberately made to feel expensive. Its description tells the
model that asking suspends everything, that you may not answer for hours, and
that it's worth it only when guessing wrong would cost more than waiting. That
prompt text is doing real engineering work — there's no clever gate here,
because the failure mode is judgement, not permission.

---

## What it looks like

```
  Oscar                                you
  ─────                                ───
  mid-task, hits a real choice
    → saves the question
    → notification ─────────────────▶  "Oscar has a question"
    → sleeps                            (stays on screen until tapped)

                                       open Oscar
                                       ◀── greeted with what's waiting
                                       tap "Python"
    ◀── answer arrives as the tool
        result it was waiting for
    → carries straight on
```

Pending questions appear **at the top of the page**, above the ask box. A
suspended run is genuinely blocked on you, so burying it below the fold would
mean work quietly sitting still.

When Oscar supplies **options**, they render as buttons. One tap is the
difference between a question answered on a bus and one still sitting there
tomorrow — the tool description pushes hard for options wherever the answer is a
choice between known alternatives.

---

## How resuming actually works

This is the part worth understanding, because it's what makes an answer feel
seamless hours later.

When `ask_user` fires, the round is **frozen mid-flight**. The assistant's tool
calls are already in the conversation; what gets parked is the tool *results* —
with the question's own slot left empty. Your answer fills that slot, and the
round completes.

Parking **every** result, not just the question's, is the detail that matters.
Other tools in the same round have already run and had their side effects.
Throwing their output away and re-running them later would repeat those.

The consequence: the model's next turn sees a perfectly ordinary conversation in
which a tool it called returned your answer. Nothing in the history hints that
hours went by in the middle of it.

---

## Inside a mission

A question suspends **the whole mission**, not just the task that asked.

There's nobody watching a mission, so carrying on with later steps while a
question hangs would mean building on a decision that hasn't been made. When you
answer, the mission resumes on the same step, against the same plan.

Note this is unaffected by a mission never stopping for *confirmations*. A
mission doesn't pause to confirm an action it's allowed to take — but it
absolutely pauses when it doesn't know something. Those are different problems:
one is permission, the other is information.

---

## Setup

Nothing to configure beyond what you already have.

- **Supabase.** The question needs somewhere to live. Without it `ask_user` is
  withheld from the model entirely — a run that suspends with no row to wake it
  is just a run that stopped.
- **Notifications** ([PUSH.md](PUSH.md)). Optional but close to essential: a
  question you never hear about stalls a run indefinitely. The notification for
  a question stays on screen until tapped and is held for 24 hours, unlike
  ordinary status updates.

Re-run `db/schema.sql` in Supabase to add the `questions` table. Safe to paste
whole, as always.

Check `/api/health` → `questions.available: true`.

**Asking needs no write authority.** Asking a question changes nothing in the
world, so gating it behind writes would just leave the read-only path guessing
instead of checking. Answering, on the other hand, is session-only — it resumes
a run that can write files and spend credit, which is more than the Shortcut key
should be able to do.

---

## When something breaks

| Symptom | Cause |
| --- | --- |
| Oscar guesses instead of asking | Working as intended, mostly — asking is deliberately rare. Say "ask me if you're unsure" |
| Oscar asks too much | Tell it what you don't care about up front, or set `OSCAR_PERSONA` |
| A run is stuck at "waiting on you" and there's no question | The question was cancelled or expired. The run won't resume — start it again |
| Answered, but nothing happened | The run had already finished or failed. The answer is still recorded; see the `reason` in the reply |
| Tapped twice, worried it ran twice | It didn't. The second tap gets "already answered" and resumes nothing |
| No notification when it asked | Push isn't set up, or no device subscribed. See [PUSH.md](PUSH.md) |

To see what's outstanding:

```sql
select created_at, question, job_id from public.questions
where status = 'pending' order by created_at desc;
```

Questions don't expire on their own. If you want them to:

```sql
update public.questions set status = 'expired'
where status = 'pending' and created_at < now() - interval '7 days';
```
