# Building the iOS Shortcut

Goal: say **“Hey Siri, Ask Oscar”**, speak a question, and get the answer as a
notification a few seconds later.

You need your deployed URL (e.g. `https://oscar-xyz.vercel.app`) and your
`OSCAR_SHARED_SECRET` value. Have both in front of you.

> **Why the Shortcut doesn't use the website login.** The website asks for a
> password and then a code emailed to you. A Shortcut can't read your inbox, so
> it authenticates with the `x-oscar-key` header instead. That secret is
> equivalent to your password — anyone with it can spend your OpenAI credit —
> but it can't be used to get a website session. Rotate it in Vercel if a phone
> goes missing.

---

## The shortcut, action by action

Open **Shortcuts → + → Add Action** and build this in order.

### 1. Dictate Text

Search "Dictate Text".

- **Language** — your language
- **Stop Listening** — `After Pause` (tap "After Short Pause" to change it)

This is the piece that makes it voice-driven. Siri listens, converts to text,
and hands the text to the next action.

### 2. Get Contents of URL

Search "Get Contents of URL". Paste your URL, then tap the **arrow (⌄)** on the
action to expand its options.

- **URL** — `https://YOUR-APP.vercel.app/api/ask`
- **Method** — `POST`
- **Headers** — tap *Add new header*:
  - Key: `x-oscar-key`  Value: *your OSCAR_SHARED_SECRET*
- **Request Body** — `JSON`, then *Add new field*:
  - Type `Text`, Key `question`, Value: tap the value box and pick the
    **Dictated Text** variable from the suggestion bar above the keyboard.
  - *(optional)* Type `Text`, Key `tz`, Value `America/Los_Angeles` — lets the
    agent answer "what time is it in Tokyo" and "what's today's date" correctly.

> If the variable chip says "Shortcut Input" instead of "Dictated Text", tap it
> and choose Dictated Text — this is the single most common mistake.

### 2b. Giving Oscar your location

*Optional but strongly recommended if you want weather questions to work.*

Without this, Oscar guesses where you are from your IP address, which on a
mobile network is often a different city and on a VPN is wherever the exit node
lives.

Add **Get Current Location** as a new action, and drag it **above** *Get
Contents of URL*. Then add two more fields to the JSON body in step 2:

- Type `Number`, Key `latitude`, Value: tap the value box → **Current
  Location** variable → tap it again → choose **Latitude**
- Type `Number`, Key `longitude`, Value: same, but choose **Longitude**

The first time you run it, iOS asks for location permission. Allow it — the
coordinates go only to your own Vercel function.

> **What happens to them.** Coordinates are used to fetch weather and are then
> discarded. They are never written to the database; the log records only which
> tools ran. See TOOLS.md.

If picking Latitude/Longitude is fiddly, an easier alternative: add one `Text`
field with key `location` and drop the whole **Current Location** variable in.
Oscar parses the `"47.6062, -122.3321"` form too.

### 3. Get Dictionary Value

Search "Get Dictionary Value".

- **Get** — `Value`
- **Key** — `answer`
- **from** — `Contents of URL`

### 4. Show Notification

Search "Show Notification".

- **Title** — type `Oscar` (or leave blank)
- **Body** — the `Dictionary Value` variable from step 3
- Expand it and turn **Play Sound** on or off to taste

### 5. Name it

Tap the shortcut name at the top → rename to **Ask Oscar**. The name is the
Siri phrase, so pick something you can say cleanly. "Ask Oscar" works well;
avoid names that collide with Siri's built-ins.

---

## Using it

- **“Hey Siri, Ask Oscar”** → Siri runs it, listens, then the notification lands.
- Add it to your **Home Screen** (share icon → Add to Home Screen) for a tap version.
- On iPhone 15 Pro and later, assign it to the **Action Button**:
  Settings → Action Button → Shortcut → Ask Oscar.
- Add it to **Control Center** or the **Lock Screen** for one-tap access.

---

## Handling deletions — the Yes/No prompt

Oscar can delete calendar events, delete tasks, and move mail to the bin. When
you dictate a destructive request it **does not act immediately**. It replies
with a question and a signed token, and waits for you to tap Yes.

    you:    "delete the event on Thursday"
    Oscar:  Delete "Dentist" on Thursday, August 20 at 2:00 PM?   [No] [Yes]
    you:    tap Yes
    Oscar:  Deleted "Dentist".

Typed requests in the web console skip this — you typed it deliberately with the
answer on screen. Dictation is where mishearing happens, so that's where the
question appears. (The console's own mic button asks too.)

### Adding it to your Shortcut

Everything above stays as it is. Insert these actions **after** *Get Contents of
URL* and **before** *Show Notification*.

**1. Get Dictionary Value** — key `needsConfirmation`, from *Contents of URL*

**2. If** — *Dictionary Value* **is** `1`

> Shortcuts renders JSON `true` as `1`. If the comparison never matches, switch
> the condition to **is not** `0`, which behaves the same and is less fussy.

Everything from here to **Otherwise** goes *inside* the If.

**3. Get Dictionary Value** — key `confirmPrompt`, from *Contents of URL*

**4. Choose from Menu** — prompt: the `confirmPrompt` variable from step 3.
Set exactly two items, in this order:

  - `No`
  - `Yes, delete`

> This is the yes/no button pair. Put **No** first so the safer option is the one
> nearest your thumb.

**5. In the `No` branch:** add **Show Notification** with body
`Cancelled — nothing was changed.` Nothing else. No request is made, so nothing
can be deleted by accident.

**6. In the `Yes, delete` branch:**

  a. **Get Dictionary Value** — key `confirmToken`, from *Contents of URL*

  b. **Get Contents of URL**
     - URL: `https://YOUR-APP.vercel.app/api/confirm`
     - Method: `POST`
     - Headers: `x-oscar-key` → your `OSCAR_SHARED_SECRET`
       **and** `x-oscar-write` → your `OSCAR_WRITE_SECRET`
     - Request Body: `JSON`
       - Type `Text`, Key `token`, Value: the *Dictionary Value* from 6a
       - Type `Text`, Key `confirm`, Value: `Yes`

  c. **Get Dictionary Value** — key `answer`, from the *Contents of URL* in 6b

  d. **Show Notification** — body: that *Dictionary Value*

**7. Otherwise** (the plain, no-confirmation path): your original **Get
Dictionary Value** for `answer` and **Show Notification**, unchanged.

### Why both headers on /api/confirm

The token proves *what* you agreed to. It does not prove *who is asking now*. So
`/api/confirm` re-checks write authority, and a request carrying only the read
key is refused even with a perfectly valid token. Without that, a token captured
from a write-enabled request could be replayed by anything holding the read key.

### The token expires in five minutes

Long enough to read a notification and tap; short enough to be useless if
someone finds it later. Past that, ask again.

### If you'd rather not build the branching

You don't have to. An un-updated Shortcut still works: `answer` contains the
confirmation question, so you'll see *"Delete Dentist on Thursday…?"* as a
notification. Nothing gets deleted — you just have no way to say yes. Deletions
then only work from the web console.

---

## Nicer variants

### Show the long answer too

Insert a second **Get Dictionary Value** for the key `detail`, then use
**Show Result** or **Show Alert** after the notification. `detail` is empty when
the short answer already covers it, so a `Text` + `If` check is worth adding if
this bugs you.

### Have it read the answer aloud

Instead of (or after) *Show Notification*, add **Speak Text** with the
`speak` key from the response. Good for driving or AirPods.

### Feed it text from the share sheet

In the shortcut settings (ⓘ icon), enable **Show in Share Sheet** and accept
`Text` and `URLs`. Then replace *Dictate Text* with an **If** that uses
`Shortcut Input` when there is one and dictation when there isn't — that gives
you "explain this selected text" from any app.

### Ask about your clipboard

Add **Get Clipboard** and a **Text** action containing:

```
Question: [Dictated Text]

Context from my clipboard: [Clipboard]
```

then send that Text action as `question` instead.

---

## Response reference

`POST /api/ask` returns:

| key         | what it is                                            |
| ----------- | ----------------------------------------------------- |
| `ok`        | `true` on success                                     |
| `title`     | ≤5 word headline, good for the notification title     |
| `answer`    | the short answer — this is the one you want           |
| `detail`    | longer version, often empty                           |
| `speak`     | `answer` + `detail` merged, for **Speak Text**        |
| `model`     | which model answered                                  |
| `elapsedMs` | how long the model took                               |
| `tools`     | which tools ran, e.g. `["get_weather"]`               |
| `needsConfirmation` | `true` when a destructive action is waiting on a yes/no |
| `confirmPrompt`     | the question to show, e.g. `Delete "Dentist" on…?`      |
| `confirmToken`      | signed token to POST to `/api/confirm`                  |
| `canWrite`          | whether this request may change anything                |

Failures return the **same shape** with `ok: false` and a human-readable
`answer`, so a broken key or an out-of-credit account shows up as a readable
notification rather than a silent no-op.

---

## When it doesn't work

| What you see                            | Cause                                                            |
| --------------------------------------- | ---------------------------------------------------------------- |
| Notification says "Not authorised"       | `x-oscar-key` header doesn't match `OSCAR_SHARED_SECRET` on Vercel |
| Notification says "missing OPENAI_API_KEY"| Env var not set in Vercel, or set but not redeployed             |
| "insufficient_quota"                     | OpenAI account needs credit                                       |
| Shortcut errors before any notification  | Usually the JSON body field is empty — recheck step 2             |
| Nothing happens at all                   | Notifications are off for Shortcuts: Settings → Notifications → Shortcuts |
| Takes >10s                               | Switch `OPENAI_MODEL` to a smaller/faster model                   |
| Weather is for the wrong city            | No GPS being sent — add step 2b above                             |
| "I could not work out where you are"     | No GPS, and your IP didn't resolve. Add step 2b or set `OSCAR_HOME_LOCATION` |
| Notification asks to confirm but there are no buttons | The confirmation branch isn't built yet — see "Handling deletions" above |
| "That confirmation has expired"          | More than five minutes passed. Ask again                          |
| Confirm returns 403                      | The `x-oscar-write` header is missing from the `/api/confirm` request |
| The If never matches                     | Compare `needsConfirmation` with **is not** `0` instead of **is** `1` |

To debug without the phone, open your deployed URL in a browser — the test
console there calls the identical endpoint and shows the raw error.
