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

Four gates stand in front of any command:

| Gate | Stops |
| --- | --- |
| `writes: true` on the tool | The read-only "Ask Oscar" Shortcut. A lost phone cannot run code on your machine. |
| `confirm: true` on the tool | A misheard dictation. The command is read back before it runs. |
| The runner's own policy | Everything else, on the machine itself. |
| The confirmation gate | Destructive commands, by asking you on your phone. |

And two limits you should know about:

- Commands are confined to `--root`. A `cwd` resolving outside it is **refused,
  not clamped** — running somewhere other than where you were told produces
  results that look right and aren't.
- The runner has exactly the privileges of the user who started it.
  **Do not run it as administrator.**

### What stops to ask

Between "fine" and "never" there is a third answer: **not without you.**

Deleting a file, killing a process, installing a package, moving something,
writing to the registry, `git reset --hard` — all legitimate things to want
done, and all things you would rather not have happen because a dictation was
misheard. Those stop, send a question to your phone, and run only if you say
yes. Anything else is a no: silence is a no, a network failure is a no, and
after five minutes an unanswered command is a no.

There are two places to choose how much asks, and they answer to each other.

**On the website**, under Settings, is the one you will actually use:

| Setting | What happens |
| --- | --- |
| No commands at all | Nothing runs. The tool is withheld from the model and the runner is handed no work. |
| Every command, with confirmation | Each one asks you first, harmless ones included. |
| Only risky commands need confirmation | **Default.** Deleting, moving, installing and discarding work ask; reading and building just run. |
| Every command, without confirmation | They run. The denylist still refuses the catastrophic ones. |

The runner picks this up on its next poll, within a few seconds. Nothing to
restart.

The default is the third one, and deliberately not the second. A setting that
asks about `git status` teaches you to approve without reading, and an approval
given without reading protects nothing.

**On the laptop** is `--confirm`, which is finer-grained and which wins
when you pass it. Without it, the website decides; with it, this machine is
pinned and the website cannot loosen it. The runner says which is in charge in
its startup banner.

Note what the website can and cannot reach. It can change how much this machine
**asks**. It can never change what this machine **refuses** — the denylist, the
allowlist, the root confinement and the escalation ban are all still decided on
the laptop and are not reachable from the deployment at any setting.

| `--confirm` | What asks first |
| --- | --- |
| `destructive` (default) | The risky ones listed above |
| `all` | Every single command |
| `none` | Nothing. Only the denylist is left |

The asking happens **on the laptop**, for the same reason the policy does. The
server is asked to deliver the question and report the answer; the laptop
decides what the answer means. A deployment that had been tampered with could
refuse to ask you — in which case nothing runs — but it cannot manufacture a
yes it was never given.

> If push notifications are not set up, the question still appears on the
> website and the runner prints a line saying nothing took the notification.
> It is not silent, but it is much less useful, so set up push. See PUSH.md.

### PowerShell is on the allowlist, and why that is not a hole

The allowlist deliberately has no `sh`, `bash` or `cmd` on it: one shell makes
the whole list decorative, because everything it refuses can be respelled as
`sh -c "..."`. **PowerShell is an exception**, and the reason is that writing a
file is the point of this feature — no other allowlisted program does it, and
shell redirects (`echo x > file.js`) are split and refused.

What keeps it honest is that the exception is paired with the gate. Destructive
patterns are matched against the **whole command line**, including inside
quotes, so `pwsh -c "Remove-Item build"` is seen and held exactly as bare
`Remove-Item build` would be. Writing files is silent; deleting them asks.

The honest limit: this catches destructive commands, not disguised ones.
Someone who can queue commands and wants to hide one behind base64 or a
variable will manage it. The gate is built against accident and
overconfidence, which is the realistic failure, not against an attacker who
already holds `OSCAR_RUNNER_SECRET`.

Privilege escalators are the one thing with no middle setting. `sudo`, `su`,
`doas` and `runas` are refused in every mode, at every `--confirm` level. There
is no answer you could give that makes running Oscar as somebody else wise.

### What the policy refuses outright

Always, in every mode: recursive deletes of a filesystem root, `mkfs`/`fdisk`/
`format`, raw writes to `/dev/`, shutdown and reboot, fork bombs, piping a
download into a shell, disabling the firewall or antivirus, deleting user
accounts, force-pushing `main`, and running as another user (`sudo`, `runas`).

The `git` subcommands that throw work away — `reset --hard`, `clean -f`,
`branch -D` — used to be here. They are now in the tier above: recoverable
enough to be worth asking about rather than refusing, since wanting one of
them is perfectly ordinary. Force-pushing `main` stayed here, because it is
the one that takes other people's work with it.

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
  mode        allowlist (74 programs)
  confirm     destructive commands ask first

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
npm run runner -- --confirm all        # ask before every command
npm run runner -- --confirm none       # never ask (denylist only)
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
| A command sits at `HELD` and nothing happens | It is waiting for you. Answer it on the website, or set up push so it reaches your phone |
| `NOT RUN — no answer within 5 minutes` | The question went unanswered. Ask again; raise `OSCAR_CONFIRM_TIMEOUT_MS` if five minutes is too short |
| Everything asks, including `git status` | You started it with `--confirm all` |

To watch what has been asked for:

```sql
select created_at, status, exit_code, command from public.commands
order by created_at desc limit 50;
```
