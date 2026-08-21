# Looking someone up

> *"Who is torvalds?"*

Oscar checks eleven public sites for that handle, reads the profile each one
publishes, and tells you what they say — including which sites it could not
check, and why.

```
 "who is torvalds"
        │
        ├── find_username ──▶ github     found   Linus Torvalds · Linux Foundation · Portland, OR
        │                     keybase    found   proofs: github/torvalds, twitter/…
        │                     mastodon   found   …
        │                     bluesky    found   …
        │                     hackernews absent
        │                     reddit     not checked — blocks servers, here is the link
        │
        ├── lookup_profile ─▶ github, in full: bio, company, recent repositories
        │
        └── lookup_domain ──▶ the personal site that profile linked to:
                              registrar, registered 2007, expires 2026
```

Everything here is public: the same pages anyone can open in a browser, fetched
through each site's own documented API. No keys, no accounts, no logins.

---

## The three tools

| Tool | What it does |
| --- | --- |
| `find_username` | Checks a handle across every site in the catalogue and returns what each says. The search step. |
| `lookup_profile` | Reads one site's profile in full, plus recent repositories on GitHub. The read step. |
| `lookup_domain` | The public registration record for a domain, over RDAP. |

The split is the same as `search_email` → `read_email`: fan out once to find
where the signal is, then go back for depth on the one or two that mattered.
`find_username` already returns a short profile for every hit, so `lookup_profile`
is only worth calling when you want more than the summary gave you.

---

## Three states, not two

This is the design decision the whole feature rests on.

The obvious way to check a handle is to fetch the profile URL and call 200
"taken" and 404 "free". It is also wrong, and wrong in the direction that
produces confident lies. Measured against the real endpoints, from a server:

- **pypi.org** returns 200 and a bot-check page for a real user *and* for a
  nonsense one. Status-only logic reports every username on earth as a PyPI user.
- **reddit.com** returns 403 to datacenter IPs whoever you ask about. A "not
  found" there means "Reddit would not talk to us", not "nobody".
- **t.me** serves a full 200 page for handles that do not exist.

So every check resolves to one of three states, and the third one is reported
rather than hidden:

| State | Means |
| --- | --- |
| `found` | That site has an account with that exact name. |
| `absent` | That site does not. |
| `unknown` | The site could not be asked — rate limit, block, timeout. **Not** evidence either way. |

An `unknown` is never rounded down to "no". The system prompt says so, the tool
descriptions say so, and there is a test asserting that a GitHub 403 comes back
as `unknown` rather than `absent`.

**A false "found" is worse than a shrug.** Someone asks who a handle belongs to,
and whatever comes back becomes part of what they believe about a person.

### The sites that are not probed

Some sites cannot be checked from a server at all. Rather than guessing, Oscar
lists them with the URL so you can look yourself:

| Site | Why not |
| --- | --- |
| Reddit | Blocks server requests (HTTP 403) whoever is asked about |
| PyPI | Answers every request with a bot check, so real and fake look identical |
| Telegram | Serves a normal page for handles that do not exist |
| Instagram, X, Facebook | Require a login |
| TikTok | Blocks server requests |
| LinkedIn | Requires a login, and its terms forbid automated access |

Nothing tries to get around any of this. There is no browser impersonation, no
CAPTCHA solving, no scraping behind a login. A site that has said no has said no,
and the honest version of the same help is a link.

---

## The catalogue

Eleven sites, each checked through its own public API. Every entry was verified
against a real account *and* a nonsense one before it was allowed in — the
`found` / `absent` rules below describe what was actually observed, not what the
documentation promises.

| Site | Endpoint | What comes back |
| --- | --- | --- |
| GitHub | `api.github.com/users/…` | Name, bio, company, location, website, repos, followers, joined |
| GitLab | `gitlab.com/api/v4/users?username=` | Name, account state |
| Hacker News | `hacker-news.firebaseio.com` | Karma, joined, about text |
| Keybase | `keybase.io/_/api/1.0/user/lookup.json` | **Proven accounts on other sites**, name, location, bio |
| Mastodon | `mastodon.social/api/v1/accounts/lookup` | Display name, bio, followers, verified profile links |
| Bluesky | `public.api.bsky.app` | Display name, bio, followers, joined |
| Lobsters | `lobste.rs/~…json` | Karma, about, linked GitHub and Twitter, who invited them |
| DEV | `dev.to/api/users/by_username` | Name, bio, location, website, linked GitHub and Twitter |
| Docker Hub | `hub.docker.com/v2/users/…` | Full name, location, company, joined |
| Chess.com | `api.chess.com/pub/player/…` | Name, title, country, joined, last online |
| npm | `registry.npmjs.org` search | Published packages |

Four of these are worth a note.

**Keybase is the best stop on the list.** Its proofs are cross-site identity
links that the person published and signed themselves — "this Keybase account is
also this GitHub account, and here is the proof". That is consent and evidence in
one, which almost nothing else in OSINT gives you.

**Hacker News is case-sensitive.** `pg` and `PG` are different people.

**Mastodon means mastodon.social only.** There are thousands of other servers,
and absent there means absent from that one. The tool result says so in as many
words so the model does not overstate it.

**npm cannot see accounts any more** — the user document went behind auth. What
is still public is the package search, so npm answers a narrower question: *has
this name published anything?* Finding nothing therefore cannot mean "no
account", and npm is the one site whose negative is reported as `unknown` rather
than `absent`.

---

## The one that isn't here, and why

The standard OSINT playbook includes harvesting email addresses out of public Git
commits — `api.github.com/users/NAME/events/public` returns commit payloads, and
commit metadata carries the author's address. It is public, it is easy, and it is
not here.

The difference is between a field someone filled in and a field they left a trace
in. A profile bio was written to be read. A commit email is plumbing that happens
to be visible, and the reason GitHub offers `noreply` addresses at all is that
people are surprised to find it exposed. Harvesting it is also the one move on
the list whose main real-world use is spam.

It is a deliberate omission, not a missing feature. The same reasoning that keeps
`lib/tools/location.js` off BigDataCloud's endpoint applies here: what is
technically reachable and what is fair to take are different questions.

---

## What Oscar is told to do with the results

The results are handed to the model with the caveats attached, because this is
where a lookup tool turns into a rumour mill. From the system prompt:

> When you looked someone up online, say which site each fact came from, and
> never merge matching handles into one person as though it were established. A
> site you could not check is "I could not check it", never "they are not on it".

The same handle on eight sites is one person's habit or eight strangers'
coincidence, and the data cannot tell you which. So Oscar attributes — "GitHub
says Portland, the Mastodon bio says Oslo" — rather than assembling one confident
biography out of parts that may not belong together.

---

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `OSCAR_DISABLE_OSINT` | *(unset)* | `1` withholds all three tools. |
| `OSCAR_GITHUB_TOKEN` | *(unset)* | Raises the GitHub rate limit from 60/hour to 5,000. Needs **no scopes**. |
| `OSCAR_OWNER_EMAIL` | *(unset)* | Goes in the `User-Agent` so the APIs can see who is calling. |

The tools need no key and change nothing, so they are available on the same terms
as the weather — no write authority, no confirmation gate, no database. They are
withheld entirely when `OSCAR_DISABLE_OSINT=1`, because they do reach out to a
dozen third parties from your deployment's IP and not every network wants that.

**Rate limits.** GitHub's unauthenticated 60/hour is per IP and shared with
everything else on that serverless host, so it is the first one you will hit. A
scopeless token fixes it. Nothing else in the catalogue has a limit you are
likely to reach from one person asking questions.

---

## Where the boundary is

These tools read public profiles. That covers checking your own footprint,
recognising who is emailing you, background on a handle before you deal with it,
and the ordinary curiosity of "who is this person".

What is not built, and would not be a small change to build:

- **No login, ever.** Nothing authenticates as anyone, to anything.
- **No bot-detection bypass.** No browser impersonation, no CAPTCHA solving. A
  site that blocks servers is reported as blocked.
- **No breach data.** No credential dumps, no leaked-password lookups.
- **No bulk anything.** One handle per call, a strict format, eleven sites.
  There is no list input and no way to sweep a thousand names.
- **No inference presented as fact.** States, sources and caveats, not verdicts.

The uncomfortable part of OSINT is that "it was public" is a fact about
*availability*, not about consent. Someone who put a bio on Mastodon in 2019 did
not thereby agree to be assembled. The design here — attribute everything, prove
nothing, refuse the sites that said no, and leave out the harvesting move — is
what that concern looks like in code rather than in a disclaimer.

---

## Adding a site

In `lib/osint.js`, add an entry to `SITES`:

```js
{
  id: 'example',
  label: 'Example',
  probe: (u) => `https://example.com/api/users/${encodeURIComponent(u)}`,
  profile: (u) => `https://example.com/${encodeURIComponent(u)}`,
  // Omit `decide` when 200 means found and 404 means absent.
  decide: ({ status, json }) => (json && json.exists ? 'found' : 'absent'),
  summarize: (j) => compact({ displayName: j.name, bio: stripHtml(j.about) }),
}
```

Then — and this is the part that matters — **check it against a real account and
a nonsense one before you commit it.** Not the documentation: the endpoint.

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://example.com/api/users/someone-real"
```

If both come back the same, the site does not belong in `SITES`. Put it in
`BLOCKED_SITES` with a one-line reason and let the user click the link. Three of
the eight entries in `BLOCKED_SITES` are there because they failed exactly this
check after looking perfectly reasonable on paper.

Nothing in `lib/agent.js` or `lib/tools/index.js` needs to change; the tools read
the catalogue at call time, including the `enum` in their own schemas.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| GitHub always comes back `unknown` | The 60/hour limit. Set `OSCAR_GITHUB_TOKEN`. |
| "does not look like a username" | The handle had a character outside `A–Z a–z 0–9 . _ -`, or was over 40 characters. |
| Everything is `unknown` | No outbound network from the deployment, or all eleven timed out. |
| A site you expect is missing | It is probably in `BLOCKED_SITES` — check `notChecked` in the result. |
| Mastodon says absent for someone you know is there | They are on another instance. Only mastodon.social is checked. |
| Bluesky says absent | Only the default `name.bsky.social` handle is checked, not custom domains. |
| The sweep is slow | Eleven requests, six at a time, 6s timeout each. Worst case is about 12s. |
