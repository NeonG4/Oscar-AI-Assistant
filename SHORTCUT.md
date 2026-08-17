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

To debug without the phone, open your deployed URL in a browser — the test
console there calls the identical endpoint and shows the raw error.
