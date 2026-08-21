/**
 * lib/tools/osint.js
 * ----------------------------------------------------------------------------
 * "Who is torvalds?"
 *
 *   find_username   → which public sites have that handle, and what each says
 *   lookup_profile  → one of those sites, asked properly
 *   lookup_domain   → who registered the personal site a profile pointed at
 *
 * A search tool and a read tool, the same shape as search_email / read_email:
 * fan out once to find where the signal is, then go back for depth on the one
 * or two that mattered. The sweep already returns a short profile for every
 * hit, so the model only pays for `lookup_profile` when it actually wants more.
 *
 * WHY THESE READ AS CAREFULLY AS THEY DO
 *
 * The descriptions below spend most of their words on what a result does NOT
 * mean, because that is where this kind of tool goes wrong. The same handle on
 * eight sites is one person's habit or eight strangers' coincidence, and the
 * data cannot tell you which. A model that reports "torvalds is on Chess.com"
 * has quietly invented a fact. So the tools hand back states rather than
 * verdicts, `unknown` is never rounded to `no`, and the model is told in as
 * many words to attribute what it says to the site that said it.
 *
 * Read-only, all of it. Nothing here has `writes: true`, nothing needs the
 * confirmation gate, and nothing needs a key — which is why these are available
 * on the same terms as the weather.
 */

import { sweepUsername, fetchProfile, lookupDomain, siteIds, OsintError } from '../osint.js';

/* --------------------------------------------------------- find_username */

export const findUsernameTool = {
  name: 'find_username',
  description:
    'Find out who a username or handle belongs to by checking the public sites that publish ' +
    'profiles, and returning what each one says about it. This is the tool for "who is X", ' +
    '"look up the handle X", "does X have a GitHub", or checking where the user\'s own handle ' +
    'appears. Every site is checked through its own public API — this is the same information ' +
    'anyone could read in a browser. ' +
    'READING THE RESULT: `found` means that site has an account with that exact name. `absent` ' +
    'means it does not. `unknown` means the site could not be asked — rate limits, a block, a ' +
    'timeout — and you must NEVER report an unknown as "no account"; say you could not check it. ' +
    '`notChecked` lists sites that cannot be probed at all, with links the user can open. ' +
    'THE THING TO GET RIGHT: the same handle on several sites is evidence, not proof. Different ' +
    'people reuse the same name. Say what each site actually shows rather than merging it all ' +
    'into one confident biography, and if the profiles disagree about name, location or job, ' +
    'say that they disagree.',
  parameters: {
    type: 'object',
    properties: {
      username: {
        type: 'string',
        description:
          'The handle to look for, e.g. "torvalds". A leading @ is fine, and a pasted profile ' +
          'URL will have the username taken out of it.',
      },
      sites: {
        type: 'array',
        items: { type: 'string', enum: siteIds() },
        description:
          'Only check these sites. Omit to check all of them, which is usually what you want. ' +
          'Use it when the user asked about one particular site.',
      },
    },
    required: ['username'],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    return sweepUsername(args.username, { sites: args.sites }, ctx);
  },
};

/* -------------------------------------------------------- lookup_profile */

export const lookupProfileTool = {
  name: 'lookup_profile',
  description:
    'Read one public profile in full, for a site you already know the person is on — usually a ' +
    '`found` result from find_username, or a site the user named directly ("what is her GitHub ' +
    'bio?"). Returns the profile fields that site publishes, and for GitHub also the ' +
    'repositories pushed to most recently, which is the best single clue to what someone ' +
    'actually works on. Do not call this for every hit from find_username — that sweep already ' +
    'returned a summary of each. Call it when you need more than the summary gave you.',
  parameters: {
    type: 'object',
    properties: {
      site: {
        type: 'string',
        enum: siteIds(),
        description: 'Which site to read the profile from.',
      },
      username: { type: 'string', description: 'The handle on that site.' },
    },
    required: ['site', 'username'],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const result = await fetchProfile(args.site, args.username, ctx);
    if (result.state === 'absent') {
      return { ...result, note: `There is no ${result.label} account with that name.` };
    }
    if (result.state === 'unknown') {
      return {
        ...result,
        note: `I could not check ${result.label}. This is not evidence either way.`,
      };
    }
    return result;
  },
};

/* --------------------------------------------------------- lookup_domain */

export const lookupDomainTool = {
  name: 'lookup_domain',
  description:
    'Look up the public registration record for a domain name — registrar, when it was first ' +
    'registered, when it expires, and its nameservers — over RDAP, the official replacement for ' +
    'WHOIS. Useful as the next step after a profile links a personal site: the registration date ' +
    'tells you how long someone has been at that address. ' +
    'Registrant names and contact details are redacted on almost every domain since GDPR. That ' +
    'is the default for everyone and says nothing about the owner, so never present a redacted ' +
    'record as though the person were hiding something.',
  parameters: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'The domain, e.g. "example.com". A full URL is fine; it will be trimmed.',
      },
    },
    required: ['domain'],
    additionalProperties: false,
  },

  async run(args = {}, ctx = {}) {
    const result = await lookupDomain(args.domain, ctx);
    if (result.registered === false) {
      return { ...result, note: 'That domain is not registered.' };
    }
    return result;
  },
};

export { OsintError };
