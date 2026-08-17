# Environment variables — the complete guide

Every secret and setting Oscar uses, where to get it, and how to check it
worked. Written to be followed top to bottom on a fresh setup.

If you just want the checklist, jump to [The 15-minute path](#the-15-minute-path).

---

## Contents

- [How environment variables work here](#how-environment-variables-work-here)
- [The 15-minute path](#the-15-minute-path)
- [Generating random secrets on Windows](#generating-random-secrets-on-windows)
- [Full variable reference](#full-variable-reference)
  - [`OPENAI_API_KEY`](#openai_api_key--required)
  - [`OPENAI_MODEL`](#openai_model--optional)
  - [`OSCAR_MAX_WORDS`](#oscar_max_words--optional)
  - [`OSCAR_PERSONA`](#oscar_persona--optional)
  - [`OSCAR_SHARED_SECRET`](#oscar_shared_secret--required)
  - [`OSCAR_PASSKEY`](#oscar_passkey--required)
  - [`OSCAR_PASSKEY_HASH`](#oscar_passkey_hash--optional)
  - [`OSCAR_OWNER_EMAIL`](#oscar_owner_email--required)
  - [`OSCAR_SESSION_SECRET`](#oscar_session_secret--strongly-recommended)
  - [`RESEND_API_KEY`](#resend_api_key--recommended)
  - [`POSTMARK_TOKEN`](#postmark_token--alternative-to-resend)
  - [`SENDGRID_API_KEY`](#sendgrid_api_key--alternative-to-resend)
  - [`OSCAR_MAIL_FROM`](#oscar_mail_from--optional)
  - [`OSCAR_ALLOWED_ORIGINS`](#oscar_allowed_origins--rarely-needed)
- [Database variables](#database-variables)
- [Verifying your setup](#verifying-your-setup)
- [Troubleshooting](#troubleshooting)
- [Rotating and revoking](#rotating-and-revoking)
- [Rules that keep you out of trouble](#rules-that-keep-you-out-of-trouble)

---

## How environment variables work here

An environment variable is a named value the server can read but nobody else
can. It's how a secret reaches your code without ever being written into the
code — which matters because the code goes into git, and git history is
forever.

There are three places these values live, and they do different jobs:

| Where | What it is | Committed to git? |
| --- | --- | --- |
| **Vercel → Settings → Environment Variables** | The real thing. What production actually reads. | No — lives in Vercel |
| **`.env.local`** on your machine | Only for running locally. | **No** — gitignored |
| **`.env.example`** in the repo | A template with fake values, so you can see what's needed. | **Yes**, on purpose |

### Do you need `.env.local`?

**No.** Deploy to Vercel, set the variables in the dashboard, and you never
create that file. It exists for two situations:

- You want to run `npm start` or `vercel dev` and try changes before deploying.
- You want to test with a throwaway OpenAI key.

`npm test` needs no variables at all — it uses fakes.

If you do want to work locally, the shortcut is:

```bash
vercel env pull .env.local
```

That downloads your production values into `.env.local` so you don't retype
them. The file is already in `.gitignore`.

### The gotcha that will get you once

**Vercel bakes environment variables in at deploy time.** Adding or changing one
in the dashboard does nothing to the site that's already running. You must
redeploy:

```bash
vercel --prod
```

Nine out of ten "I set the key and it still says missing" reports are this.

### Environments

Vercel offers three checkboxes when you add a variable: **Production**,
**Preview**, **Development**. For a personal tool, tick all three — it saves
confusion later when a preview deploy mysteriously can't send email. The one
exception: if you ever use a separate test OpenAI key, put the real key on
Production only.

### Adding variables from the terminal

The dashboard is easier for the first pass, but this works too:

```bash
vercel env add OPENAI_API_KEY production
# paste the value when prompted, then:
vercel --prod
```

---

## The 15-minute path

In order, because some steps depend on earlier ones.

1. **OpenAI key** → [instructions](#openai_api_key--required). Add credit or nothing will work.
2. **Resend key** → [instructions](#resend_api_key--recommended). Free, no domain needed.
3. **Generate two random secrets** → [instructions](#generating-random-secrets-on-windows). One for `OSCAR_SHARED_SECRET`, one for `OSCAR_SESSION_SECRET`. Different values.
4. **Choose a password** for `OSCAR_PASSKEY`. A passphrase you'll actually remember.
5. **Your email address** for `OSCAR_OWNER_EMAIL` — must be the address you signed up to Resend with.
6. Paste all six into Vercel → Settings → Environment Variables.
7. `vercel --prod`
8. Open `/api/health` and confirm everything reads `true`.

Minimum viable set:

```
OPENAI_API_KEY
OSCAR_PASSKEY
OSCAR_OWNER_EMAIL
OSCAR_SHARED_SECRET
OSCAR_SESSION_SECRET
RESEND_API_KEY
```

---

## Generating random secrets on Windows

Two of these variables need to be long and random. Don't invent them by hand —
human-chosen strings are far more guessable than they feel.

You already have Node installed, so this is the reliable option in any terminal
(Command Prompt, PowerShell, or Git Bash):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

That prints 64 hex characters. Run it **twice** — once for
`OSCAR_SHARED_SECRET`, once for `OSCAR_SESSION_SECRET`. They must be different
values, so that leaking one doesn't compromise the other.

PowerShell 7 alternative, if you'd rather not use Node:

```powershell
[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

(That line needs PowerShell 7+. On the older Windows PowerShell 5.1 that ships
with Windows, use the Node command instead.)

Most guides say `openssl rand -hex 32`. That works if you have Git Bash or WSL,
but Windows has no `openssl` by default — hence the Node version above.

---

## Full variable reference

### `OPENAI_API_KEY` — required

**What it does:** lets the server call OpenAI. Without it every question returns
"Server is missing OPENAI_API_KEY."

**How to get it:**

1. Go to <https://platform.openai.com> and sign in. Note this is the *API
   platform*, a separate product from ChatGPT — a ChatGPT Plus subscription does
   **not** include API credit, and API usage is billed separately.
2. **Add credit first.** Click your profile icon (top right) → **Billing** →
   **Add payment details** → add a balance. There's usually a $5 minimum. Skip
   this and your key will exist but every request fails with
   `insufficient_quota`.
3. Left sidebar → **API keys** → **Create new secret key**.
4. Name it something like `oscar`. If you're offered a project, the default is
   fine.
5. Copy the key — it starts with `sk-`. **It's shown once.** If you lose it,
   delete it and make another; there's no way to view it again.

**Worth doing while you're there:** Settings → **Limits** → set a monthly budget
cap. If a key ever leaks, this is the difference between a bad day and a bad
month. $5–10 is generous for personal use.

**Cost in practice:** with the default model, a question and answer is a
fraction of a cent. Current rates are at
<https://openai.com/api/pricing>.

**Verify:** `/api/health` → `agent.openaiKey: true`, then ask a question.

---

### `OPENAI_MODEL` — optional

**Default:** `gpt-4o-mini`

Which model answers. The default is deliberate: it's fast and cheap, and this
is a "how long do I boil an egg" assistant, not a research tool. Speed matters
more than depth when you're standing in a kitchen waiting for a notification.

Change it if answers feel too shallow — but expect responses to take longer,
which is felt directly since the Shortcut waits. Current model names are listed
at <https://platform.openai.com/docs/models>.

**Verify:** `/api/health` → `agent.model` shows your value; the pill in the top
right of the web console shows it too.

---

### `OSCAR_MAX_WORDS` — optional

**Default:** `60`

Hard cap on the notification body. This exists because iOS truncates a
notification banner at roughly 3–4 lines — anything past that is only visible if
you pull the notification down.

The cap is enforced twice: the model is told the limit, and the server trims
anything longer on a word boundary. Raise it if you plan to have the Shortcut
speak answers rather than show them.

---

### `OSCAR_PERSONA` — optional

**Default:** empty

Free-text standing instructions appended to every request. This is how you make
Oscar yours without touching code:

```
Answer in metric. I live in Seattle. I'm a high school student, so explain
things clearly but don't be condescending. Prefer concrete examples.
```

Keep it under a few sentences — it's sent with every single question, so it
costs tokens each time and dilutes the instructions that keep answers short.

---

### `OSCAR_SHARED_SECRET` — required

**What it does:** the iOS Shortcut's credential. The Shortcut sends it as the
`x-oscar-key` header, and requests without it are refused. This is the only
thing standing between the open internet and your OpenAI balance.

**Why the Shortcut doesn't use the website password:** a Shortcut can't open
your email to read a sign-in code, so it can't complete two-factor login. It
gets a long secret instead.

**How to get it:** generate one — see
[Generating random secrets](#generating-random-secrets-on-windows). Don't reuse
a password; nothing has to remember this except your phone.

**Where it goes:** Vercel, *and* into the Shortcut's `x-oscar-key` header — see
`SHORTCUT.md` step 2.

**Security note:** it lives in plain text inside a Shortcut on your phone.
Someone with your unlocked phone can read it. It cannot be used to sign into the
website, only to ask questions.

**Verify:** `/api/health` → `auth.sharedSecret: true`, then run the Shortcut.

---

### `OSCAR_PASSKEY` — required

**What it does:** the password you type on the website. Correct password →
a code is emailed to you. Both are needed; the password alone gets you nothing
but an email.

**How to choose one:** a passphrase you'll remember without a manager, since
you'll type it on a phone keyboard. Four unrelated words beats a short scramble
— `walnut-harbor-tuesday-lamp` is both easier to type and harder to guess than
`Xk7!q2`.

Don't reuse a password from anywhere else.

**Verify:** `/api/health` → `auth.passkey: true`, then sign in.

---

### `OSCAR_PASSKEY_HASH` — optional

An alternative to `OSCAR_PASSKEY` for when you'd rather not have the plaintext
password sitting readable in your Vercel dashboard. Store the SHA-256 hash
instead:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('YOUR PASSWORD HERE').digest('hex'))"
```

Set that hex string as `OSCAR_PASSKEY_HASH` and delete `OSCAR_PASSKEY`. If both
exist, the hash wins.

**Set one or the other, not both.** And keep in mind this is a modest
improvement, not a big one — a plain SHA-256 of a weak password is quick to
crack offline. It protects against someone glancing at your screen, not against
a determined attacker who obtains the hash. A strong passphrase matters more.

---

### `OSCAR_OWNER_EMAIL` — required

**What it does:** the single address sign-in codes are sent to. It's read from
the server's own settings and never from anything the browser submits — so an
attacker can't redirect the code to themselves by tampering with the request.

**What to use:** whichever inbox you check fastest on your phone.

**One constraint:** if you're using Resend's shared sender (the default), this
must be the email you signed up to Resend with. Sending anywhere else needs a
verified domain. Details in the Resend section below.

**Consequence worth accepting deliberately:** your email account is now part of
your security. Anyone who can read that inbox *and* knows your password can sign
in. Make sure that account has 2FA of its own.

**Verify:** `/api/health` → `auth.ownerEmail: true`. The sign-in screen shows a
masked version (`da***@gmail.com`) so you can confirm it's the right address
without publishing it.

---

### `OSCAR_SESSION_SECRET` — strongly recommended

**What it does:** signs your login sessions and the mid-login challenge tokens.
It's what lets the server verify a session cookie it never stored — the reason
this project needs no database.

**If you don't set it,** the code falls back to `OSCAR_SHARED_SECRET`. That
works, but it entangles two separate systems: rotating the Shortcut's key would
also log out every browser, and vice versa. Set its own value.

**How to get it:** generate one — see
[Generating random secrets](#generating-random-secrets-on-windows). Must be
different from `OSCAR_SHARED_SECRET`.

**The useful property:** changing this value and redeploying instantly
invalidates every existing login session everywhere, without touching your
Shortcut. That's your "sign out of all devices" button — see
[Rotating and revoking](#rotating-and-revoking).

**Verify:** `/api/health` → `auth.sessionSecret: true`.

---

### `RESEND_API_KEY` — recommended

**What it does:** sends the sign-in code to your email. Whichever mail provider
key you set is the one used — the code auto-detects. Set **one** of Resend,
Postmark, or SendGrid.

Resend is the easiest of the three by a wide margin, because it can send from a
shared address without you owning a domain.

**How to get it:**

1. Go to <https://resend.com> and sign up. **Use the address you want codes sent
   to** — this matters for step 5.
2. Verify your email when their confirmation arrives.
3. In the dashboard, left sidebar → **API Keys** → **Create API Key**.
4. Name it `oscar`. Permission: **Sending access** is enough. Domain: leave as
   all domains.
5. Copy the key — it starts with `re_`. Like the OpenAI key, it's shown once.

**The domain question:** by default Oscar sends from `onboarding@resend.dev`,
Resend's shared testing sender. It works immediately with no DNS setup, but it
can **only deliver to the email address on your Resend account**. That's
normally exactly what you want here.

If you need codes sent somewhere else, add and verify a domain in Resend
(Domains → Add Domain → add the DNS records they give you), then set
`OSCAR_MAIL_FROM` to an address at that domain.

**Free tier:** generously more than you'll use for personal logins. Current
limits at <https://resend.com/pricing>.

**You can skip this at first.** With no mail provider set, the sign-in code is
written to your Vercel function logs instead (Vercel → your project → **Logs**),
and the login screen tells you so. That's enough to test the entire flow before
signing up anywhere.

**Verify:** `/api/health` → `auth.mailProvider: "resend"`. If it says `"log"`,
the key isn't being seen — check for typos and that you redeployed.

---

### `POSTMARK_TOKEN` — alternative to Resend

Excellent deliverability; the choice if codes ever land in spam elsewhere.

1. Sign up at <https://postmarkapp.com>.
2. **Sender Signatures** → add your email address → click the verification link
   they send. Postmark will not send from an unverified address, so this step
   isn't optional.
3. **Servers** → your server → **API Tokens** → copy the *Server API token*.
4. Set `OSCAR_MAIL_FROM` to the exact address you verified in step 2.

Set only this — leave `RESEND_API_KEY` empty.

---

### `SENDGRID_API_KEY` — alternative to Resend

1. Sign up at <https://sendgrid.com> and complete their identity verification
   (the most tedious of the three).
2. **Settings → Sender Authentication → Single Sender Verification** → add and
   verify your address.
3. **Settings → API Keys → Create API Key** → *Restricted Access* with **Mail
   Send** enabled. Copy it — starts with `SG.`.
4. Set `OSCAR_MAIL_FROM` to your verified sender.

Set only this — leave the other two empty.

---

### `OSCAR_MAIL_FROM` — optional

The From address on the code email. Format: `Oscar <oscar@yourdomain.com>` or a
bare `oscar@yourdomain.com`.

**Defaults to** `Oscar <onboarding@resend.dev>` when using Resend, which is why
Resend works with zero extra configuration.

**Required** if you use Postmark or SendGrid, and it must exactly match the
sender you verified with them — otherwise the send is rejected and you'll see
"The code could not be emailed."

---

### `OSCAR_ALLOWED_ORIGINS` — rarely needed

Extra website origins permitted to call the API with your login cookie, comma
separated. Your own deployment is always allowed automatically, so leave this
empty unless you're building a second front-end.

Understand what you're doing before setting it: adding an origin here lets that
site make authenticated requests using your session. Only list sites you fully
control.

---

## Verifying your setup

Open `https://your-app.vercel.app/api/health`. You should see:

```json
{
  "ok": true,
  "service": "oscar",
  "agent": {
    "openaiKey": true,
    "model": "gpt-4o-mini",
    "maxWords": 60
  },
  "auth": {
    "passkey": true,
    "ownerEmail": true,
    "sessionSecret": true,
    "mailProvider": "resend",
    "sharedSecret": true
  },
  "database": { "configured": true }
}
```

Every boolean `true`, and `mailProvider` not `"log"`. The endpoint reports only
booleans and never the values themselves, so it's safe to open on your phone and
safe to leave public — which is the point, since you need it most when you're
locked out.

Then, in order:

1. Open the site → sign in with your password → check your email for the code.
2. Ask a question in the console. You should get an answer in a few seconds.
3. Run the Shortcut on your phone.

If step 2 works and step 3 doesn't, the problem is the `x-oscar-key` header in
the Shortcut, not your environment variables.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/api/health` shows `false` for something you set | You didn't redeploy. `vercel --prod` |
| Still `false` after redeploying | Variable name typo, or it wasn't ticked for the Production environment |
| "Server is missing OPENAI_API_KEY" | As above |
| `insufficient_quota` from OpenAI | Key is valid but the account has no credit. Add a balance |
| `401` / "Incorrect API key" | Key was revoked, or you pasted a truncated copy |
| "The code could not be emailed" | Provider key wrong, or `OSCAR_MAIL_FROM` isn't a verified sender |
| Code never arrives, health says `"log"` | No provider key detected — it's in your Vercel logs |
| Code never arrives, health says `"resend"` | Check spam. If using the shared sender, confirm `OSCAR_OWNER_EMAIL` is your Resend account address |
| "That password is not right" | `OSCAR_PASSKEY` mismatch. Watch for a trailing space in the pasted value |
| Login succeeds then immediately signs you out | `OSCAR_SESSION_SECRET` changed between the two requests, or you're on `http://` over a LAN IP — session cookies are `Secure` |
| Shortcut says "Not authorised" | `x-oscar-key` doesn't match `OSCAR_SHARED_SECRET` |
| Everything works locally, nothing in production | Values are in `.env.local` but were never added to Vercel |
| History tab says no database configured | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` missing, or not redeployed |
| `/api/health?deep=1` shows `reachable: false` | Table missing (run `db/schema.sql`) or you copied the `anon` key instead of `service_role` |

---

## Rotating and revoking

**If your OpenAI key leaks:** delete it at
<https://platform.openai.com/api-keys> immediately, create a new one, update
Vercel, redeploy. Check your usage page for unexpected spend.

**If your Shortcut secret leaks** (lost phone): generate a new
`OSCAR_SHARED_SECRET`, update Vercel, redeploy, then update the header in the
Shortcut on your remaining devices. The old value stops working the moment the
deploy completes.

**To sign out every browser everywhere:** generate a new
`OSCAR_SESSION_SECRET`, update Vercel, redeploy. Every session dies instantly,
including any an attacker holds. Your Shortcut is unaffected. This is the single
most useful emergency lever in the project — it's why the variable is worth
setting separately.

**If you suspect your password is known:** change `OSCAR_PASSKEY`, and rotate
`OSCAR_SESSION_SECRET` at the same time to kill any session already created with
the old one.

**Routine rotation** isn't necessary for a personal tool. Rotate on suspicion,
on a lost device, or when someone else has had access to your machine.

---

## Rules that keep you out of trouble

1. **Never commit a real secret.** `.env.local` is gitignored; keep it that way.
   `.env.example` holds placeholders only.
2. **Never put a secret in `public/`.** Everything in that folder is downloaded
   by every visitor's browser. Secrets belong in `api/` and `lib/`, which run
   server-side only.
3. **If a secret ever reaches git, rotate it.** Deleting the file doesn't help —
   it's still in the history, and on a public repo it's already been scraped.
4. **Set a spend cap on your OpenAI account.** The cheapest insurance available.
5. **Different values for different variables.** Never reuse
   `OSCAR_SHARED_SECRET` as `OSCAR_SESSION_SECRET`.
6. **Redeploy after every change.** Say it three times.

---

## Database variables

Optional. Without them Oscar works exactly as before, just without a log.
Full walkthrough in **[SUPABASE.md](./SUPABASE.md)** — this is the summary.

### `SUPABASE_URL` — optional

Your project's REST endpoint, e.g. `https://abcdefghijkl.supabase.co`.

Supabase → **Project Settings → API → Project URL**. Copy it exactly; a trailing
slash is tolerated but nothing else is.

Must be set together with `SUPABASE_SERVICE_ROLE_KEY` — one without the other is
treated as "not configured" and logging silently stays off.

### `SUPABASE_SERVICE_ROLE_KEY` — optional

Supabase → **Project Settings → API → Project API keys → `service_role`**
(behind a Reveal button).

> **Pick the right key.** Supabase shows two. The **anon** key is meant to be
> public and embedded in browsers. The **service_role** key **bypasses Row Level
> Security entirely** — whoever holds it has full read and write access to your
> whole database, ignoring every policy.
>
> Oscar deliberately uses `service_role` server-side, which is what lets the
> table stay locked to everyone else. The consequence: this key must never
> appear in `public/`, never be sent to a browser, and never reach git. Treat it
> exactly like your OpenAI key.
>
> If it leaks: Project Settings → API → **Reset** the service_role key, then
> update Vercel and redeploy.

**Before this works** you also need to create the table — paste `db/schema.sql`
into Supabase's SQL Editor and run it.

**Verify:** open `/api/health?deep=1` and look for
`"database": { "configured": true, "reachable": true }`. The `?deep=1` matters:
without it the endpoint only reports whether the variables are set, while with
it a real query runs, proving the URL, the key *and* the table are all good.

### `SUPABASE_TABLE` — optional

**Default:** `conversations`

Only needed if you renamed the table in `db/schema.sql`.

---

## Variables you don't need yet

Nothing in the current code reads these. Listed only so you recognise them if
you extend Oscar later, per the ideas in the README:

| Name | Would be for |
| --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | True single-use codes and login attempt lockout |
| `NTFY_TOPIC` / `PUSHCUT_URL` | Pushing answers asynchronously for long-running requests |
