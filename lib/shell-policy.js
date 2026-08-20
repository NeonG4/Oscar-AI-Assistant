/**
 * lib/shell-policy.js
 * ----------------------------------------------------------------------------
 * What the local runner is willing to execute.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SERVER
 *
 * This is the last line of defence, and it runs ON THE LAPTOP — inside
 * scripts/runner.js, after the command has already been through the model, the
 * database and the network. Every one of those could in principle be wrong,
 * compromised, or talked into something. This check is the one that isn't
 * reachable from any of them.
 *
 * So the rule is: the server may decide what to ASK for. Only this file decides
 * what RUNS. Keep it that way. Moving any of it server-side for convenience
 * would quietly remove the only protection that survives a bad day.
 *
 * TWO MODES
 *
 *   allowlist (default) — the first word of every segment must be a known-safe
 *                         program. Unknown program, no run. Boring and strict.
 *   unrestricted        — anything except the denylist. Opt in with --unrestricted
 *                         when you know what you're doing and want the agent to
 *                         actually build things.
 *
 * THE DENYLIST APPLIES IN BOTH. There is no mode in which Oscar reformats a
 * disk because a dictation was misheard.
 */

/**
 * Things that are never acceptable, in any mode.
 *
 * Aimed at the irreversible and the self-defeating: destroying a filesystem,
 * wiping a disk, killing the machine, turning off its defences, or piping the
 * internet straight into a shell. Not an attempt at a complete sandbox — a
 * determined attacker with allowlisted `node` can do plenty. It is a guard
 * against catastrophe by accident, which is the realistic failure here.
 */
export const DENY_PATTERNS = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*[/~]\s*$/i, why: 'recursive delete of the filesystem root' },
  { re: /\brm\s+-[rf]{1,2}\s+\/(\s|$)/i, why: 'recursive delete of /' },
  { re: /\brm\s+(-[a-z]+\s+)*(--no-preserve-root)/i, why: 'delete with --no-preserve-root' },
  { re: /\b(mkfs(\.\w+)?|fdisk|parted|diskpart)\b/i, why: 'disk partitioning or formatting' },
  { re: /\bdd\b[^|;]*\bof=\/dev\//i, why: 'raw write to a device' },
  { re: /\bformat\s+[a-z]:/i, why: 'formatting a drive' },
  { re: /\bdel\s+\/[sf]\b[^|;]*[a-z]:\\?\s*$/i, why: 'recursive delete of a drive root' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: 'shutting the machine down' },
  { re: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/, why: 'fork bomb' },
  { re: /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/i, why: 'piping a download straight into a shell' },
  { re: /\b(netsh\s+advfirewall|ufw\s+disable|iptables\s+-F)\b/i, why: 'disabling the firewall' },
  { re: /\bset-mppreference\b[^|;]*disablerealtimemonitoring/i, why: 'disabling antivirus' },
  { re: /\bchmod\s+(-[a-z]+\s+)*777\s+\/(\s|$)/i, why: 'opening up the filesystem root' },
  { re: /\b(userdel|net\s+user\s+\S+\s+\/delete)\b/i, why: 'deleting a user account' },
  { re: /\bgit\s+push\b[^|;]*--force\b[^|;]*\b(main|master)\b/i, why: 'force-pushing a main branch' },
  { re: /\b(history\s+-c|Clear-History)\b/i, why: 'clearing shell history' },
];

/**
 * Programs the allowlist mode permits.
 *
 * Chosen to cover "look at my code and tell me about it" and ordinary local
 * development, while leaving out anything whose whole purpose is to change the
 * system: no package managers with system scope, no service control, no user
 * management. `git` is here but its destructive subcommands are caught below.
 */
export const DEFAULT_ALLOWED = [
  // reading and navigating
  'ls', 'dir', 'pwd', 'cd', 'cat', 'type', 'head', 'tail', 'less', 'more',
  'find', 'grep', 'rg', 'wc', 'stat', 'file', 'tree', 'du', 'df', 'which', 'where',
  'echo', 'printf', 'date', 'whoami', 'hostname', 'env',
  // source control
  'git', 'gh',
  // runtimes and build tools
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'deno', 'bun',
  'python', 'python3', 'pip', 'pip3', 'pytest', 'poetry',
  'dotnet', 'go', 'cargo', 'rustc', 'java', 'javac', 'mvn', 'gradle',
  'make', 'cmake', 'tsc', 'jest', 'vitest', 'eslint', 'prettier',
  // writing files in a controlled way
  'mkdir', 'touch', 'cp', 'copy', 'mv', 'move',
  // misc
  'sort', 'uniq', 'cut', 'sed', 'awk', 'jq', 'diff', 'code', 'curl',
];

/** git subcommands that throw work away. Refused even though `git` is allowed. */
const GIT_DESTRUCTIVE = /^git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force|branch\s+-D|checkout\s+--\s)/i;

/**
 * Split a command line into the segments a shell would run separately.
 *
 * This is the part that stops `git status && rm -rf /` from passing an
 * allowlist that only ever looked at the first word. It is a deliberately
 * coarse split — it does not try to be a shell parser, and it treats anything
 * it cannot confidently read as another segment to check rather than as text
 * to ignore. Erring toward "check it too" is the safe direction.
 */
export function splitSegments(command) {
  return String(command || '')
    .split(/&&|\|\||[;|\n]|(?<!\d)>(?!>)|>>/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The program a segment invokes, lowercased and stripped of any path. */
export function programOf(segment) {
  const first = String(segment || '').trim().split(/\s+/)[0] || '';
  // Strip env-var prefixes like FOO=bar node script.js
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
    const rest = String(segment).trim().split(/\s+/).slice(1).join(' ');
    return rest ? programOf(rest) : '';
  }
  const base = first.split(/[\\/]/).pop() || '';
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * May this command run?
 *
 * @param {string} command
 * @param {{mode?: 'allowlist'|'unrestricted', allowed?: string[]}} [options]
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkCommand(command, options = {}) {
  const text = String(command || '').trim();
  if (!text) return { ok: false, reason: 'Empty command.' };
  if (text.length > 4000) return { ok: false, reason: 'Command is too long.' };

  // The denylist runs against the whole line first, because some of the
  // patterns span what the splitter would treat as separate segments.
  for (const { re, why } of DENY_PATTERNS) {
    if (re.test(text)) return { ok: false, reason: `Refused: ${why}.` };
  }

  const segments = splitSegments(text);

  for (const segment of segments) {
    for (const { re, why } of DENY_PATTERNS) {
      if (re.test(segment)) return { ok: false, reason: `Refused: ${why}.` };
    }
    if (GIT_DESTRUCTIVE.test(segment)) {
      return { ok: false, reason: 'Refused: that git command discards work irreversibly.' };
    }
  }

  if (options.mode === 'unrestricted') return { ok: true };

  const allowed = new Set((options.allowed || DEFAULT_ALLOWED).map((s) => String(s).toLowerCase()));
  for (const segment of segments) {
    const program = programOf(segment);
    if (!program) continue;
    if (!allowed.has(program)) {
      return {
        ok: false,
        reason:
          `Refused: "${program}" is not on the allowlist. ` +
          'Add it with --allow, or start the runner with --unrestricted.',
      };
    }
  }

  return { ok: true };
}
