# Letting Oscar use your computer

*"Run the tests on my laptop"* → it does, and reads you the result.

This is the most powerful thing Oscar can do and the only part that can damage
something you care about. Read the first section before you turn it on; the
setup is five minutes and is further down.

---

## How it works, and why it's built this way

Oscar runs on Vercel. Your laptop sits behind NAT with no inbound port and is
closed half the time, so **the server can never reach into your machine.** That
constraint decides the whole design:

```
  Oscar (Vercel)                 Supabase                    your laptop
  ─────────────                  ────────                    ───────────
  run_cmd tool
    → queue a row  ──────────▶  commands
                                  status: queued
                                                   ◀──────   poll /api/runner
                                                              claim it
                                  status: claimed
                                                              CHECK THE POLICY
                                                              run it in a shell
                                  status: done     ◀──────   post the output
    ◀── stdout, exit code ────
```

Every connection is **outbound from your laptop**. No port forwarding, no
dynamic DNS, no hole in your firewall, and it works from a café. If the laptop
is shut, commands simply wait in the queue and expire after ten minutes rather
than running at some surprising later moment.

### The part that matters

**The laptop decides what runs.** Not the model, not the database, not the API.

`lib/shell-policy.js` is re-checked locally by `scripts/runner.js` *after* the
command has already passed through the model, the network and Supabase. Every
one of those could in principle be wrong or compromised. The local check is the
one that isn't reachable from any of them, which is precisely why the same check
is done twice and why the second one is the one that counts.

Three gates stand in front of any command:

| Gate | Stops |
| --- | --- |
| `writes: true` on the tool | The read-only "Ask Oscar" Shortcut. A lost phone cannot run code on your machine. |
| `confirm: true` on the tool | A misheard dictation. The command is read back before it runs. |
| The runner's own policy | Everything else, on the machine itself. |

And two limits you should know about:

- Commands are confined to `--root`. A `cwd` resolving outside it is **refused,
  not clamped** — running somewhere other than where you were told produces
  results that look right and aren't.
- The runner has exactly the privileges of the user who started it.
  **Do not run it as administrator.**

### What the policy refuses

Always, in every mode: recursive deletes of a filesystem root, `mkfs`/`fdisk`/
`format`, raw writes to `/dev/`, shutdown and reboot, fork bombs, piping a
download into a shell, disabling the firewall or antivirus, deleting user
accounts, force-pushing `main`, and the `git` subcommands that throw work away
(`reset --hard`, `clean -f`, `branch -D`).

Chained commands are split and **every segment is checked** — `git status && rm
-rf /` does not get through on the strength of its first word.

This is a guard against catastrophe by accident, which is the realistic failure
here. It is **not** a sandbox: in `--unrestricted` mode, or with `node` on the
allowlist, a determined attacker who could queue commands could do plenty. Treat
`OSCAR_RUNNER_SECRET` as seriously as any other key.

---

## Setup

### 1. Generate a secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

This is `OSCAR_RUNNER_SECRET`. It is a **separate secret**, not your Shortcut key
and not your write key — so if the laptop is ever stolen you rotate this one
value and the machine is cut off without disturbing anything else.

### 2. Add it to Vercel

**Settings → Environment Variables**, ticked for Production, Preview and
Development:

- `OSCAR_RUNNER_SECRET` → the value from step 1

Then redeploy. Vercel bakes env vars in at deploy time:

```bash
vercel --prod
```

Check it landed — `/api/health` should show `runner.configured: true`.

### 3. Put the same secret on your laptop

In `.env.local` in the project folder (already gitignored):

```
OSCAR_RUNNER_SECRET=the-same-value
OSCAR_BASE_URL=https://your-app.vercel.app
```

### 4. Start the runner

```bash
npm run runner
```

You should see:

```
Oscar runner on YOUR-MACHINE
  deployment  https://your-app.vercel.app
  root        C:\Users\you\source\repos\Oscar
  mode        allowlist (72 programs)

Waiting for commands. Ctrl-C to stop.
```

Leave it going. Now ask Oscar, from the web console: *"what's the git status of
my Oscar repo?"*

> Writes must also be on for any of this — `OSCAR_ALLOW_WRITES=1`. Without it
> `run_cmd` is withheld from the model entirely, the same as every other write
> tool.

---

## Options

```bash
npm run runner -- --root ~/code        # confine commands to one tree
npm run runner -- --allow docker,psql  # add programs to the allowlist
npm run runner -- --unrestricted       # anything except the denylist
npm run runner -- --interval 5000      # poll less often
npm run runner -- --once               # claim one command, then exit
```

**Start with the default allowlist.** It already covers `git`, `node`, `npm`,
`python`, `dotnet`, `go`, `cargo`, the build tools and the read-only shell
commands — enough for "look at my repo and tell me what's in it" and for running
tests. Reach for `--unrestricted` when you actually hit its limits, not before,
and prefer `--allow` for the one program you're missing.

Note that no shell (`sh`, `bash`, `powershell`, `cmd`) and no privilege
escalator (`sudo`, `su`) is on the default allowlist, and a test asserts that
stays true. A single one of them would make the allowlist decorative.

---

## When something breaks

| Symptom | Cause |
| --- | --- |
| Oscar says it can't reach your computer | The runner isn't started, or `OSCAR_BASE_URL` is wrong |
| `run_cmd` isn't offered at all | `OSCAR_RUNNER_SECRET` unset on the server, or you didn't redeploy |
| "That action needs write permission" | `OSCAR_ALLOW_WRITES` isn't `1`, or the request had no write authority |
| `Not authorised` in the runner's output | The secret on the laptop doesn't match the one in Vercel |
| Commands expire without running | The laptop was asleep. They only wait ten minutes, by design |
| `"x" is not on the allowlist` | Add it with `--allow x`, or use `--unrestricted` |
| Refused as outside the root | Pass a `cwd` inside `--root`, or start the runner with a wider `--root` |

To watch what has been asked for:

```sql
select created_at, status, exit_code, command from public.commands
order by created_at desc limit 50;
```
