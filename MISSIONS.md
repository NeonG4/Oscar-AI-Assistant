# Missions

*"Write me a connect 4 program."*

Oscar breaks that into steps, saves them, works through them one at a time, and
notifies you when it's done. You don't watch it happen.

---

## What makes a mission different from a job

A **job** is one conversation spread across several serverless invocations. It
works well right up until the conversation itself becomes the problem: after
twenty tool calls the message history is enormous, every round re-sends all of
it, and the model's attention is spread across everything it has ever done
rather than the thing in front of it. Cost climbs and quality falls, together.

A **mission** doesn't keep one long conversation. It keeps a **task list**, and
runs a separate short conversation for each step of it.

```
  planning     one run, whose only job is to produce the task list
     ↓
  working      one run per step, in order — each starting fresh
     ↓
  wrapping     one run to summarise, with no tools
     ↓
  notify, and stop
```

Between steps the agent is **thrown away**. What survives is:

- **the task list** — which steps exist, which are done. The durable memory.
- **the notes** — one line per finished step, carried into the next.
- **the ledger** — everything the mission has *made*: the document, the file,
  the calendar entry. Id, name and link.

That's the whole trick. Each step begins with only the goal, the task list, the
notes so far, and the single step it's meant to do. **Step 8 costs about what step 1
cost**, so a mission of thirty steps is as affordable as a mission of three.

The note is what a step chose to pass forward — a filename, a decision, a value
it found. Steps are told explicitly that this sentence is the only thing carried
on, so they should put what matters in it.

### Why the ledger exists

A step with no memory of the one before it will make a second copy of whatever
that one made. Told "save it to a document", with nothing in front of it saying a
document exists, creating one is the obedient thing to do — and you end up with
the outline in one file, the story in another, and an empty third.

So every step is handed the list of what already exists, by id:

```
ALREADY CREATED by earlier steps of this mission:
  - Flower and Tomato (create_doc, id 1AbC…) — https://docs.google.com/…

Those already exist. If your step involves any of them, work on THAT one
— read it by the id above, append to it, update it.
```

Only things a tool actually *created* are listed; a document the mission merely
read is not a thing the mission made. The planner is pushed the same way from
the other end: **one step owns one thing**, produced finished, and a goal that is
really one action gets a one-step list.

---

## Getting one

Missions are routed automatically. The line the router draws is **what you end
up with**: words to read is `deep`, working software is `mission`.

| You ask | Mode |
| --- | --- |
| "write me a story about a fox" | deep |
| "build me a workout plan" | deep |
| "write me a story and put it in a Google Doc" | deep |
| "write me a connect 4 program" | **mission** |
| "build a script that scans my repos" | **mission** |

Where the words end up makes no difference. A story is a story whether it is
spoken, emailed or saved into a Doc — asking for one to be filed somewhere is
still one piece of writing and one tool call, not a project.

The keyword check is deliberately narrow — it needs both a building verb *and* a
buildable noun. A mission runs unattended for dozens of model calls, so a false
positive costs real money in a way a wrong fast/deep guess never does. Anything
unclear falls through to the classifier, which is told to prefer `deep` when in
doubt.

To force it either way, pass `mode` in the request body:

```json
{ "question": "...", "mode": "mission" }
```

### Requirements

- **`OSCAR_ALLOW_WRITES=1`.** A mission saves its task list and then acts on it. Without
  write authority it couldn't store its own task list, so a mission request is
  quietly **demoted to `deep`** rather than started and failed one step later.
- **Supabase**, for the task list and the job.
- **Notifications** ([PUSH.md](PUSH.md)) if you want to hear about it. Optional,
  but the point of a mission is not watching it.
- **The runner** ([RUNNER.md](RUNNER.md)) if the mission needs to write files or
  run commands on your machine. Without it Oscar can plan and reason, but can't
  build anything on disk.

Check `/api/health` → `missions.available: true`.

---

## What it does when things go wrong

**A step that won't converge** is abandoned after 14 rounds with an honest note
saying so, and the mission carries on. Later steps often still succeed, and the
summary says what was skipped. One stuck task holding the whole mission hostage
would be worse than an incomplete result.

**A mission that runs away** stops at 300 rounds and tells you how far it got.
Past that it's stuck, not thorough.

**A mission that breaks after doing real work is not reported as a failure.**
The run most likely to be cut short is the wrap-up — it happens last, after an
hour of hammering the provider, and its only job is to describe things that
already exist. Losing it used to turn a finished mission into "Oscar got stuck"
while the document sat in your Drive. Now the mission writes its own answer from
its notes and its ledger: what it made, with the link, and an honest **stopped
early** if it didn't get through the list.

**A provider saying "not right now"** doesn't end the mission either. When the
backoff has waited as long as one invocation can afford, the round is handed to a
fresh one with a fresh budget — five times, after which the mission reports what
it has. A 429 that means *no quota left* is excluded, since it will say the same
thing in an hour.

**A goal that needs no task list** — where the model declined to break it down —
answers directly instead of retrying. For a goal that turned out to be a
one-liner, that's the right outcome anyway.

**A mission never pauses for confirmation.** There's nobody watching to answer.
Destructive tools are still gated by write authority exactly as everywhere else;
this only means a *permitted* action doesn't stop to ask a human who isn't
there. If that makes you uneasy, that instinct is worth listening to — run
missions with the runner in its default allowlist mode, where the laptop refuses
anything it doesn't recognise.

---

## Watching one

Open Oscar while it's running. The activity log shows each tool call as it
happens, the same as any job.

Or look at the list directly. A mission's task list is Oscar's own breakdown of
the goal, but it is *stored* as a row in the `plans` table — the same drawer as
the plans you save for yourself. That has two consequences worth knowing:
*"what's next on my connect 4 plan?"* works while the mission is still going,
and his working memory turns up in `list_plans` next to your own things. When
the mission finishes the row is marked `done`, so it stops showing up as active
work.

```sql
select p.title, p.status,
       count(s.*) filter (where s.done) || '/' || count(s.*) as progress
from public.plans p left join public.plan_steps s on s.plan_id = p.id
group by p.id order by p.created_at desc;
```

---

## When something breaks

| Symptom | Cause |
| --- | --- |
| Asked for a program, got prose | Routed `deep`. Force it with `"mode": "mission"` |
| `mode` comes back `deep` on a mission request | No write authority — `OSCAR_ALLOW_WRITES` isn't `1`, or the request had none |
| Mission draws up its list, then every step fails | Probably needs the runner. See [RUNNER.md](RUNNER.md) |
| No notification when it finished | Push isn't set up, or no device subscribed. See [PUSH.md](PUSH.md) |
| "Gave up after 300 steps" | It was looping. The task list is still there — look at which step it stuck on |
| Steps are vague and unhelpful | The planning run got a thin goal. Ask for the thing you want more specifically |
| Two documents where you wanted one | The task list split making a thing from filling it in. Look at the plan row — the steps are still there |
| "Stopped early" with a link in it | The work landed, the run didn't finish. The link is real; the list wasn't completed |
