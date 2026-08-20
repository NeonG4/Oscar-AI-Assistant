# Connecting Google

Gmail, Calendar, Tasks, Drive and Docs. About 20 minutes, most of it clicking
through Google Cloud Console.

> **Read this first, or you will lose an evening.**
>
> A new Google OAuth app defaults to **"Testing"** publishing status. Google's
> own documentation: *"A Google Cloud Platform project with an OAuth consent
> screen configured for an external user type and a publishing status of
> 'Testing' is issued a refresh token expiring in 7 days."*
>
> Everything works perfectly, and then exactly one week later every Google tool
> starts failing with `invalid_grant`. **Set publishing status to "In
> production"** — step 5 below. It takes one click and needs no verification for
> personal use.

> **Already connected before Drive and Docs existed?** Adding scopes does not
> upgrade a grant you already have. Your refresh token was minted against the
> old scope list, so Drive and Docs calls will fail with 403 until you:
>
> 1. enable **Google Drive API** and **Google Docs API** (step 2), then
> 2. re-run `npm run google-auth` (step 6) and paste the new
>    `GOOGLE_REFRESH_TOKEN` into Vercel.
>
> Calendar, Tasks and Gmail keep working throughout — only the two new ones 403.

---

## What Oscar can do once connected

| Tool | Needs write access | What it does |
| --- | :---: | --- |
| `list_events` | | Read your calendar |
| `list_tasks` | | Read your to-do list |
| `search_email` | | Search Gmail, headers and snippets |
| `read_email` | | Read one message in full |
| `create_event` | ✅ | Add a calendar event |
| `create_task` | ✅ | Add a task |
| `complete_task` | ✅ | Tick a task off |
| `draft_email` | ✅ | Save a Gmail draft (never sends) |
| `send_email` | ✅ | Send mail as you |
| `search_drive` | | Find files in Drive by name |
| `read_drive_file` | | Read a Doc, Sheet, Slides or text file's contents |
| `read_doc` | | Read a Google Doc in full |
| `delete_event` | ✅ | Delete a calendar event — asks first |
| `delete_task` | ✅ | Delete a task — asks first |
| `trash_email` | ✅ | Move mail to the bin — asks first |
| `create_doc` | ✅ | Create a Google Doc and write content into it |
| `append_to_doc` | ✅ | Add to the end of an existing Doc |
| `trash_drive_file` | ✅ | Move a Drive file to the bin — asks first |

**Nothing can be destroyed permanently.** `trash_email` moves a message to the
Gmail bin and `trash_drive_file` moves a file to the Drive bin — both
recoverable for 30 days. Gmail's and Drive's permanent-delete endpoints are
deliberately not wired up. (Drive's `DELETE` skips the bin entirely, which is
exactly what a voice assistant should never be able to do.)

**Long answers become documents.** A notification is capped at a few dozen
words, so when you ask for a workout plan, a draft letter or research notes,
Oscar writes the substance into a Google Doc and reads you the link. That's
what `create_doc` is for.

**Destructive actions ask before acting when dictated.** Say "delete the event on
Thursday" and Oscar replies with *Delete "Dentist" on Thursday, August 20 at 2:00
PM?* and two buttons. Typed requests in the web console go straight through —
you typed it deliberately with the answer on screen. Details in
[TOOLS.md](./TOOLS.md#destructive-actions); the Shortcut build is in
[SHORTCUT.md](./SHORTCUT.md#handling-deletions--the-yesno-prompt).

---

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com>.
2. Project dropdown (top left) → **New Project** → name it `oscar` → **Create**.
3. Wait for it to switch to the new project. Check the dropdown actually says
   `oscar` before continuing — enabling APIs on the wrong project is the most
   common way to waste ten minutes here.

## 2. Enable the five APIs

**APIs & Services → Library**, then search for and **Enable** each of:

- **Google Calendar API**
- **Google Tasks API**
- **Gmail API**
- **Google Drive API**
- **Google Docs API**

Each takes a few seconds. Miss one and that tool fails at runtime with a 403
telling you the API is disabled. Drive and Docs are two separate APIs — enabling
Drive does not enable Docs.

## 3. Configure the consent screen

Left sidebar → **Google Auth Platform** (older accounts call this *OAuth consent
screen*).

1. **User type: External.** Internal is only available with a Google Workspace
   account; a regular `@gmail.com` cannot use it.
2. App name: `Oscar`. User support email: your address. Developer contact: your
   address again.
3. Skip adding scopes here — the authorisation script requests them directly.
4. **Audience → Test users → Add your own Gmail address.** Do this even though
   you'll publish in a moment; it costs nothing and avoids a confusing failure
   if you authorise before publishing.

## 4. Create OAuth credentials

**Google Auth Platform → Clients → Create client**

- **Application type: Web application** (not Desktop — the script uses an
  HTTP redirect).
- Name: `Oscar local auth`.
- **Authorised redirect URIs → Add URI:**

  ```
  http://localhost:4321/callback
  ```

  Exactly that, including the port and path. A mismatch here produces
  `redirect_uri_mismatch`, which is at least an honest error message.

- **Create.** Copy the **Client ID** and **Client secret**.

## 5. Publish the app — the important step

**Google Auth Platform → Audience → Publishing status → Publish app →
Confirm.**

This is what stops your refresh token expiring after 7 days.

You do **not** need to complete Google's verification process. Verification
exists to remove the "unverified app" warning for the public and to go beyond
100 users. For a personal app used by one person — you — publishing unverified
is fine. You'll see a scary warning screen once, during step 6.

## 6. Authorise Oscar

On your own machine, in the project folder:

```bash
npm run google-auth
```

It will:

1. Ask for your client id and secret (or read them from `.env.local`).
2. Ask whether to allow writes. Say **y** for full read/write.
3. Open your browser.

The consent screen now lists Drive and Docs alongside Calendar, Tasks and Gmail.
Approve all of them — a partially-approved grant fails at runtime rather than at
consent time, which is a miserable thing to debug.

> **Why Drive access is broad.** Oscar requests the full `drive` scope, not
> `drive.file`. `drive.file` only ever lets an app see files it created itself,
> which makes "find my lease agreement" impossible — the entire reason you'd ask
> Oscar about Drive. The tradeoff is real and worth stating plainly: this
> refresh token can read every file in your Drive. It is mitigated the same way
> everything else is — writes need the master switch *and* per-request
> authority, deletes ask first, and nothing can be destroyed permanently.

At the consent screen Google will say **"Google hasn't verified this app"**.
That is expected — it's your app, and you haven't submitted it for review.
Click **Advanced** → **Go to Oscar (unsafe)**.

Approve the permissions. The script prints:

```
GOOGLE_CLIENT_ID       ...
GOOGLE_CLIENT_SECRET   ...
GOOGLE_REFRESH_TOKEN   1//0g...
OSCAR_ALLOW_WRITES     1
```

> **If it prints an access token but no refresh token**, you've authorised this
> app before. Google only issues a refresh token on first consent. Revoke it at
> <https://myaccount.google.com/permissions> and run the script again.

## 7. Add the variables to Vercel

**Settings → Environment Variables**, all three environments ticked:

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | from the script |
| `GOOGLE_CLIENT_SECRET` | from the script |
| `GOOGLE_REFRESH_TOKEN` | from the script |
| `OSCAR_ALLOW_WRITES` | `1` |
| `OSCAR_WRITE_SECRET` | a fresh random string — see below |
| `GOOGLE_SEND_ALLOWLIST` | *(recommended)* `davidstall312@gmail.com` |

Generate the write secret the same way as the others:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then redeploy: `vercel --prod`

## 8. Check it

Open `/api/health`. You want:

```json
"google": { "connected": true, "writesEnabled": true, "writeSecretSet": true }
```

The same response lists exactly which tools a read-only request gets versus a
write-enabled one. Then sign in to the web console (a browser login always has
write authority) and try *"what's on my calendar today?"*.

---

## Security: how writes are gated

Sending mail as you is the most abusable thing in this project. The difference
between "someone spent my OpenAI credit" and "someone emailed my employer" is
this design, so it's worth understanding.

**Write tools are withheld, not refused.** A request without write authority
never sees `send_email` in its tool list at all. The model cannot be argued,
tricked, or prompt-injected into calling a tool it was never told exists.

**Write authority needs two independent things:**

1. `OSCAR_ALLOW_WRITES=1` on the server — your master switch. Turn it off and
   nothing can write, no matter what any request claims.
2. Proof on the request itself:
   - a **browser session** (password + a code emailed to you), or
   - the **`x-oscar-write` header** matching `OSCAR_WRITE_SECRET`.

**This is why you want two Shortcuts:**

| Shortcut | Headers | Can do |
| --- | --- | --- |
| **Ask Oscar** | `x-oscar-key` only | Read calendar, tasks, mail, weather |
| **Oscar Do** | `x-oscar-key` + `x-oscar-write` | Everything, including sending mail |

Your everyday shortcut carries only the read key. Even with that key in hand,
nobody can send email as you. Build "Oscar Do" exactly like "Ask Oscar" but add
the second header, and give it a distinct Siri phrase.

**`GOOGLE_SEND_ALLOWLIST`** is the last line of defence: a comma-separated list
of addresses `send_email` may write to. Set it to your own address while you get
comfortable. Worst case then, a compromised phone can make Oscar email *you*.

---

## About Face ID

You asked for the Shortcut to require Face ID. Here is what iOS actually
supports, because the honest answer is narrower than most guides suggest.

**There is no native "require Face ID" action in Shortcuts.** Apple doesn't
provide one. Guides that claim otherwise are either using a third-party app or
describing app locking, which is a different thing.

What genuinely works, best first:

### 1. Remove Siri from the lock screen — the real fix

**Settings → Face ID & Passcode → Allow Access When Locked → turn off Siri.**

Now "Hey Siri, Ask Oscar" does nothing until the phone is unlocked, and
unlocking is Face ID. This is the closest thing to what you asked for, it's
native, and it covers the actual threat: someone picking up your locked phone.

While you're there, turn off **Control Centre** and **Home Control** if you've
put Oscar in either.

### 2. Lock the Shortcuts app itself (iOS 18+)

Long-press the Shortcuts app icon → **Require Face ID**. This protects opening
the app to view or edit your shortcuts — which matters, because your
`OSCAR_SHARED_SECRET` is readable in plain text inside the shortcut. It does
**not** gate Siri or a Home Screen shortcut icon.

### 3. Third-party biometric action

Apps like Toolbox Pro provide an "Authenticate" action you can put at the top of
a shortcut, which does prompt for Face ID mid-run. It works, but it's a paid
third-party dependency in your critical path. Reasonable for "Oscar Do" if you
want belt and braces.

### 4. Don't put the write shortcut on the Action Button

The Action Button can fire while the phone is locked. Keep "Oscar Do" to Siri or
an in-app tap, where step 1 protects it.

**The honest summary:** an unlocked phone in someone else's hands can run your
shortcuts. Face ID protects the *locked* state. That's why the server-side write
gate exists — it's the layer that still holds when the device layer doesn't.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `invalid_grant` after about a week | Publishing status still "Testing". Step 5, then re-run step 6 |
| `invalid_grant` immediately | Token revoked, or you changed your Google password (this invalidates Gmail-scoped tokens) |
| "Google denied that request" with 403 | That API isn't enabled in Cloud Console, or you authorised before adding the scope — re-run step 6 |
| `redirect_uri_mismatch` | The redirect URI must be exactly `http://localhost:4321/callback` |
| Script prints no refresh token | Already authorised before. Revoke at myaccount.google.com/permissions and retry |
| "That action needs write permission" | Missing `x-oscar-write` header, or `OSCAR_ALLOW_WRITES` isn't `1` |
| Write tools never get used | Check `/api/health` → `tools.withWrite`. If it matches `readOnly`, writes are off |
| Calendar events at the wrong time | Send `tz` from the Shortcut — see SHORTCUT.md |
| Gmail answers feel truncated | They are. Bodies cap at 2000 characters; `bodyTruncated` flags it |
| Drive and Docs 403 but Gmail works | Your refresh token predates those scopes. Enable both APIs, then re-run step 6 |
| "A ... cannot be read as text" | Correct behaviour. Images, PDFs and binaries aren't readable; Oscar says so rather than inventing contents |
| Oscar answers a long request in one sentence | The notification cap is doing its job — ask it to put the detail in a document |

---

## What's not here yet

**Sheets.** Reading a spreadsheet works today through `read_drive_file`, which
exports it as CSV. Writing to one — adding a row, updating a cell — needs the
Sheets API and its own tool, which is the obvious next addition.

**Editing documents.** `append_to_doc` only adds to the end. Rewriting or
deleting existing text means working with Docs' index ranges, which shift as you
edit them. Deliberately deferred: an assistant that mis-edits a document you
already wrote is worse than one that can only add.
