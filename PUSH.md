# Notifications on your phone

Oscar answering a slow question is only useful if you find out it finished. This
is how it tells you — a real notification on the lock screen, sent by the
website, with no Shortcut involved.

---

## Read this first if you have an iPhone

**Web push on iOS only works for sites added to the Home Screen.** Not a
setting, not a permission you can grant in Safari — the API is simply absent in
an ordinary tab, and there is no way for a page to ask for it.

So the order is:

1. Open Oscar in Safari.
2. **Share → Add to Home Screen.**
3. Open Oscar **from the Home Screen icon**, not from Safari.
4. Sign in, then **Notifications → Turn on notifications**.

Skip step 3 and the page will tell you so rather than offering a button that
cannot work. Everywhere else — Android, desktop Chrome, Safari, Firefox — none
of this applies and the button works directly.

Requires iOS 16.4 or later.

---

## How it works

```
  Oscar (Vercel)              Apple's push service            your iPhone
  ─────────────               ───────────────────            ───────────
  encrypt the payload
  sign a VAPID token
    → POST to the endpoint ──▶  relays it, cannot
                                read it            ────────▶  sw.js decrypts
                                                              shows the notice
```

The browser hands you an endpoint belonging to its own push service, plus two
keys. Oscar encrypts each message so that **only your device can read it** —
Apple and Google relay the bytes without being able to see the text. That is
worth knowing: your notification content never becomes readable to a third
party, even though it travels through one.

The VAPID keypair is what proves a message came from your Oscar. Without it,
anyone who scraped your endpoint could push to your phone.

This is implemented directly against the specs (RFC 8291, 8188 and 8292) rather
than with the usual `web-push` package, because the project has no runtime
dependencies and adding one for ninety lines of well-specified crypto would end
that. `npm install` stays unnecessary.

---

## Setup

### 1. Generate the keypair

```bash
npm run vapid
```

Run it once. It prints two values.

### 2. Add both to Vercel

**Settings → Environment Variables**, ticked for Production, Preview and
Development:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

The public one ends up in every browser that subscribes and is meant to be seen.
The private one signs each send and must never reach `public/` or git.

Optionally `VAPID_SUBJECT` (a `mailto:` or `https:` contact for whoever operates
the sender). Without it Oscar uses `OSCAR_OWNER_EMAIL`, which is almost always
what you want.

### 3. Add the table

Paste `db/schema.sql` into **Supabase → SQL Editor** and run it. Safe to re-run
— it only adds `push_subscriptions` to what is already there.

Notifications need the database. There is nowhere else to keep the list of
devices.

### 4. Redeploy

```bash
vercel --prod
```

Check it landed: `/api/health` → `notifications.configured: true`.

### 5. Subscribe a device

Sign in, open **Notifications** under Oscar's thinking, and press **Turn on
notifications**. Then **Send a test** — it should arrive within a second or two.

---

## What you get told about

| When | Notification |
| --- | --- |
| A background job finishes | Its title and answer |
| A job needs a yes or no | Stays on screen until you tap it |
| A job fails | What went wrong |

Quick inline answers do not notify — you are already looking at them. Only work
that outlived your attention is worth interrupting you for.

Tapping a notification focuses an open Oscar tab rather than opening another.

---

## When something breaks

| Symptom | Cause |
| --- | --- |
| No Notifications section at all | `/api/health` says `notifications.configured: false` — keys missing, or you didn't redeploy |
| iPhone: "Add Oscar to your Home Screen first" | Exactly that. See the top of this page |
| "Notifications are blocked for this site" | Denied once already. Re-allow in browser settings, then reload |
| Test says sent, nothing arrives | Check Do Not Disturb / Focus, and that notifications are on for the Oscar app in iOS Settings |
| It worked, then stopped | The push service expired the subscription. Open Oscar once and it re-subscribes itself |
| Devices vanish from the list | Three consecutive failures retires a device. Turn it back on from that device |

A device that returns 404 or 410 is retired immediately — those mean the
subscription is gone for good. Anything else (a 500, a timeout) is treated as a
bad afternoon and retried, because one flaky hour should not silently
unsubscribe every device you own.

To see what is registered:

```sql
select label, created_at, last_used_at, failures from public.push_subscriptions
where expired_at is null order by created_at desc;
```
