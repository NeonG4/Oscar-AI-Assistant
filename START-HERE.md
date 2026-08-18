# Start here

Everything Oscar needs, in the order it needs doing. Three stages, each one
independently useful — **stop and test after each**. Don't do all three in one
sitting; if something breaks you want to know which stage caused it.

| Stage | Gets you | Time |
| --- | --- | --- |
| 1 | A working voice assistant on your phone | ~20 min |
| 2 | Gmail, Calendar and Tasks | ~25 min |
| 3 | A searchable log of everything you ask | ~10 min |

Tick these off as you go.

---

## Stage 0 — Where are you actually? (2 min)

Your `.env.local` contains only `VERCEL_OIDC_TOKEN`, which is what `vercel env
pull` writes when a project has **no** environment variables set. So this is
probably a fresh start — but check rather than trust that.

- [ ] Open `https://YOUR-APP.vercel.app/api/health` in a browser.

Read the response:

- Everything under `auth` is `false` → you're at the start. Do Stage 1.
- `auth` mostly `true`, `google.connected` false → skip to Stage 2.
- `google.connected` true → skip to Stage 3, or go straight to the Shortcut.

If the URL 404s or you don't know it, run `vercel ls` in the project folder.

---

## Stage 1 — A working assistant (~20 min)

Nothing here is optional. At the end you can talk to your phone and get an
answer back.

### 1.1 OpenAI key

- [ ] Go to <https://platform.openai.com> — this is the API platform, **not**
      ChatGPT. A ChatGPT subscription does not include API credit.
- [ ] **Billing → Add payment details** and put $5 on it. Do this *first*.
      Skipping it gives you a valid key that fails every request with
      `insufficient_quota`.
- [ ] **API keys → Create new secret key.** Copy it — it's shown once.
- [ ] While you're there: **Settings → Limits → set a monthly cap** of $5–10.
      This is the difference between a bad day and a bad month if a key leaks.

### 1.2 Email for sign-in codes

- [ ] Sign up at <https://resend.com> **using davidstall312@gmail.com**.

> This matters. Resend's free shared sender only delivers to the address on
> your Resend account. Sign up with a different address and codes will never
> arrive.

- [ ] Verify your email, then **API Keys → Create API Key** ("Sending access").
- [ ] Copy the `re_...` value.

### 1.3 Generate two secrets

In the project folder. Run it **twice** — the two values must differ.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- [ ] First output → `OSCAR_SHARED_SECRET`
- [ ] Second output → `OSCAR_SESSION_SECRET`

(Most guides say `openssl rand -hex 32`. Windows has no `openssl` by default —
hence Node.)

### 1.4 Put them in Vercel

**Settings → Environment Variables.** Tick **Production, Preview and
Development** for every one.

- [ ] `OPENAI_API_KEY`
- [ ] `RESEND_API_KEY`
- [ ] `OSCAR_SHARED_SECRET`
- [ ] `OSCAR_SESSION_SECRET`
- [ ] `OSCAR_OWNER_EMAIL` → `davidstall312@gmail.com`
- [ ] `OSCAR_PASSKEY` → a passphrase you'll type on a phone keyboard.
      Four unrelated words beats a short scramble.

### 1.5 Deploy

- [ ] `vercel --prod`

> **Vercel bakes env vars in at deploy time.** Changing one in the dashboard
> does nothing until you redeploy. This causes most "I set it and it still says
> missing" problems.

### 1.6 Verify — stop here if this fails

- [ ] `/api/health` → everything under `auth` is `true`, and `mailProvider`
      says `"resend"` not `"log"`.
- [ ] Open the site, sign in with your password, check Gmail for the code.
- [ ] Ask it something: *"how long do I boil an egg?"*

### 1.7 The Shortcut

- [ ] Follow **SHORTCUT.md** — four actions, about three minutes.
- [ ] Add the **Get Current Location** step (SHORTCUT.md step 2b) so weather
      knows where you are. Without it, location comes from your IP, which on
      cellular is often the wrong city.
- [ ] Test: *"Hey Siri, Ask Oscar"* → *"what's the weather?"*

**Stage 1 done.** You now have a working voice assistant. Everything below is
additive — stop here if you want to live with it for a day first.

---

## Stage 2 — Gmail, Calendar and Tasks (~25 min)

> **Read this before you start.** A new Google OAuth app defaults to "Testing"
> status, and Google issues refresh tokens that **expire after 7 days** in that
> state. Everything works, then breaks next week with `invalid_grant`. Step 2.5
> is the one-click fix. Do not skip it.

Full detail is in **GOOGLE.md**; this is the checklist.

- [ ] **2.1** <https://console.cloud.google.com> → New Project → `oscar`.
      Confirm the project dropdown says `oscar` before continuing.
- [ ] **2.2** APIs & Services → Library → **Enable** all three:
      Google Calendar API, Google Tasks API, Gmail API.
- [ ] **2.3** Google Auth Platform → consent screen → **External**,
      app name `Oscar`, your email in both contact fields.
      Add yourself under **Test users**.
- [ ] **2.4** Clients → **Create client → Web application**.
      Redirect URI, exactly: `http://localhost:4321/callback`
- [ ] **2.5** ⚠️ **Audience → Publishing status → Publish app.** The 7-day fix.
      You do *not* need Google's verification for personal use.
- [ ] **2.6** In the project folder: `npm run google-auth`
      Answer **y** to writes. At the warning screen click
      **Advanced → Go to Oscar (unsafe)** — it's your own unverified app.
- [ ] **2.7** Generate one more secret (same Node command as 1.3) for
      `OSCAR_WRITE_SECRET`.
- [ ] **2.8** Add to Vercel: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
      `GOOGLE_REFRESH_TOKEN`, `OSCAR_ALLOW_WRITES=1`, `OSCAR_WRITE_SECRET`,
      and `GOOGLE_SEND_ALLOWLIST=davidstall312@gmail.com`.

> The allowlist means `send_email` can only write to you. Worth keeping while
> you get comfortable — worst case, a compromised phone emails *you*.

- [ ] **2.9** `vercel --prod`
- [ ] **2.10** Verify: `/api/health` → `google.connected: true`,
      `writesEnabled: true`, `writeSecretSet: true`.
- [ ] **2.11** In the web console (a browser login always has write authority),
      try *"what's on my calendar today?"*

### 2.12 The second Shortcut

Your everyday Shortcut carries only the read key, so it can never send mail as
you. Writes need a second one.

- [ ] Duplicate "Ask Oscar", rename to **"Oscar Do"**.
- [ ] Add one header: `x-oscar-write` → your `OSCAR_WRITE_SECRET`.
- [ ] Give it a distinct Siri phrase.
- [ ] Build the Yes/No confirmation branch —
      **SHORTCUT.md → "Handling deletions"**. It's an **If** on
      `needsConfirmation`, a **Choose from Menu** with `No` / `Yes, delete`,
      then a POST to `/api/confirm` carrying **both** headers.

> Skippable. Without the branch, a dictated delete shows the confirmation
> question as a notification and deletes nothing — you just can't say yes from
> the phone. Deletions still work from the web.

---

## Stage 3 — Logging (~10 min, optional)

Gives you the History tab, real cost numbers, and the foundation for the
"learn about me" feature later.

- [ ] **3.1** New project at <https://supabase.com>, named `oscar`.
      Pick the region closest to your Vercel deployment — the insert is on your
      request's critical path.
- [ ] **3.2** SQL Editor → New query → paste all of `db/schema.sql` → Run.
      Safe to re-run.
- [ ] **3.3** Project Settings → API → copy **Project URL** and the
      **`service_role`** key.

> Not the `anon` key. `service_role` bypasses row-level security entirely —
> which is exactly why the table can stay locked to everyone else, and why it
> must never reach `public/` or git.

- [ ] **3.4** Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Vercel.
- [ ] **3.5** `vercel --prod`
- [ ] **3.6** Verify: `/api/health?deep=1` →
      `database: { configured: true, reachable: true }`.
      The `?deep=1` matters — it runs a real query, proving the URL, key *and*
      table all work.
- [ ] **3.7** Ask something, then open the **History** tab.

---

## When something breaks

| Symptom | Cause |
| --- | --- |
| `/api/health` shows `false` for something you set | You didn't redeploy. `vercel --prod` |
| Still `false` after redeploying | Typo in the name, or not ticked for Production |
| `insufficient_quota` | OpenAI account has no credit |
| Sign-in code never arrives | Check spam. Confirm `OSCAR_OWNER_EMAIL` is your Resend signup address |
| `mailProvider: "log"` | No `RESEND_API_KEY` detected — the code is in Vercel → Logs |
| Google fails after a week | Publishing status still "Testing". Publish, then re-run `npm run google-auth` |
| Google 403 | That API isn't enabled, or you authorised before adding a scope |
| Script prints no refresh token | You've authorised before. Revoke at myaccount.google.com/permissions and retry |
| "That action needs write permission" | Missing `x-oscar-write`, or `OSCAR_ALLOW_WRITES` isn't `1` |
| Shortcut "Not authorised" | `x-oscar-key` doesn't match `OSCAR_SHARED_SECRET` |

`npm test` needs no keys or network and should print **158 passing**. If it
does, the code is fine and the problem is configuration.

---

## Rules worth keeping

1. **Redeploy after every env var change.** Say it three times.
2. **Never commit a real secret.** `.env.local` is gitignored; keep it that way.
3. **If a secret reaches git, rotate it.** Deleting the file doesn't help — it's
   in the history.
4. **Set the OpenAI spend cap.** Cheapest insurance available.
5. **Rotating `OSCAR_SESSION_SECRET` logs every browser out instantly** without
   touching your Shortcut. That's your emergency lever.
