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
 * TWO MODES, AND A GATE BETWEEN THEM
 *
 *   allowlist (default) — the first word of every segment must be a known-safe
 *                         program. Unknown program, no run. Boring and strict.
 *   unrestricted        — anything except the denylist. Opt in with --unrestricted
 *                         when you know what you're doing and want the agent to
 *                         actually build things.
 *
 * Neither answer is enough on its own once PowerShell is allowlisted, so there
 * is a third verdict: CONFIRM. A command that is recognisably destructive stops,
 * sends a question to your phone, and runs only if you say yes. Which commands
 * do that is your choice — see CONFIRM_MODES — but the choice is enforced here,
 * on the laptop, not by the server that asked.
 *
 * THE DENYLIST APPLIES IN BOTH MODES AND IS NOT CONFIRMABLE. There is no mode,
 * and no answer you can give, in which Oscar reformats a disk.
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
  {
    // --force may come before or after the branch; people type it both ways,
    // and the old pattern only caught one of them.
    re: /\bgit\s+push\b(?=[^|;]*(--force|\s-f\b))[^|;]*\b(main|master)\b/i,
    why: 'force-pushing a main branch',
  },
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
  // PowerShell. Deliberately here, and deliberately an exception to everything
  // the comment above says about shells: a shell can express anything, so its
  // presence does make the allowlist porous. It earns its place because writing
  // a file is the point of this feature and no allowlisted program does it well.
  // What guards it is not this list but classifyCommand's confirmation gate.
  'pwsh', 'powershell',
];

/**
 * Things that are recoverable but that you would want to be asked about.
 *
 * The difference from DENY_PATTERNS is the difference between "never" and "not
 * without you". Deleting a file, killing a process, installing a package and
 * rewriting the registry are all legitimate things to want done — they are also
 * exactly what you do not want happening because a dictation was misheard or a
 * model was overconfident. So they stop and ask instead of being refused.
 *
 * Matched against the WHOLE command, not per segment, so that a destructive
 * cmdlet inside `pwsh -c "..."` is still seen. That is what makes PowerShell
 * safe enough to allowlist at all.
 *
 * The honest limit: this catches destructive commands, not disguised ones.
 * Anyone who can queue commands and wants to hide one behind base64 or a
 * variable will succeed. The gate is built against accident and overconfidence,
 * which is the realistic failure, not against a determined attacker who already
 * holds OSCAR_RUNNER_SECRET.
 */
export const DESTRUCTIVE_PATTERNS = [
  { re: /\b(rm|rmdir|rd|unlink)\b/i, why: 'deletes files or directories' },
  { re: /\b(del|erase)\b/i, why: 'deletes files' },
  { re: /\bremove-item\b/i, why: 'deletes files or directories' },
  { re: /\b(clear-content|truncate)\b/i, why: 'empties a file' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s)/i, why: 'discards local work irreversibly' },
  { re: /\bgit\s+push\b[^|;]*(--force|\s-f\b)/i, why: 'rewrites history on a remote' },
  { re: /\b(taskkill|stop-process|pkill|killall)\b/i, why: 'kills running processes' },
  { re: /\b(stop-service|start-service|restart-service|systemctl|sc\s+(stop|start|delete))\b/i, why: 'changes system services' },
  { re: /\b(reg\s+(add|delete)|new-itemproperty|set-itemproperty|remove-itemproperty)\b/i, why: 'writes to the registry' },
  { re: /\b(choco|winget|scoop|apt|apt-get|brew)\s+(install|uninstall|remove)\b/i, why: 'installs or removes software' },
  { re: /\b(npm|pnpm|yarn)\s+(install|i|add|remove|uninstall)\b[^|;]*\s-g\b/i, why: 'installs software globally' },
  { re: /\b(mv|move|move-item|rename-item|ren)\b/i, why: 'moves or renames files' },
  { re: /\b(icacls|takeown|chown|chmod|attrib)\b/i, why: 'changes file permissions or ownership' },
  { re: /\b(curl|wget|iwr|invoke-webrequest)\b[^|;]*\s-(o|outfile|outputdocument)\b/i, why: 'downloads a file onto the disk' },
  { re: /\bset-executionpolicy\b/i, why: 'changes the PowerShell execution policy' },
  { re: /\b(schtasks|register-scheduledtask|new-scheduledtask|crontab)\b/i, why: 'schedules something to run later' },
  { re: /\b(net\s+(user|localgroup)|new-localuser|add-localgroupmember)\b/i, why: 'changes user accounts' },
];

/** Which commands stop and ask. Chosen by you, enforced here on the laptop. */
export const CONFIRM_MODES = ['destructive', 'all', 'none'];

/** Privilege escalators. Never allowlisted, in any mode, gate or no gate. */
export const NEVER_ALLOWED = ['sudo', 'su', 'doas', 'runas'];

/**
 * Split a command line into the segments a shell would run separately.
 *
 * This is the part that stops `git status && rm -rf /` from passing an
 * allowlist that only ever looked at the first word.
 *
 * Quote-aware, because PowerShell is now allowlisted and its payload arrives as
 * `pwsh -c "..."`. Splitting inside that string would chop one legitimate
 * command into fragments and then refuse them for not being program names.
 * Nothing is lost by respecting quotes: DENY_PATTERNS and DESTRUCTIVE_PATTERNS
 * are both matched against the whole line as well, so a dangerous command
 * hidden inside quotes is still seen by the checks that matter.
 */
export function splitSegments(command) {
  const text = String(command || '');
  const out = [];
  let buf = '';
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }

    const pair = text.slice(i, i + 2);
    if (pair === '&&' || pair === '||' || pair === '>>') {
      out.push(buf);
      buf = '';
      i += 1;
      continue;
    }
    // `2>` is a file descriptor, not a separator.
    if (ch === '>' && !/\d/.test(text[i - 1] || '')) {
      out.push(buf);
      buf = '';
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }

  out.push(buf);
  return out.map((part) => part.trim()).filter(Boolean);
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
 * What should happen to this command?
 *
 *   allow   — run it.
 *   confirm — ask first, on a device you are holding, and run only on yes.
 *   refuse  — no, and no way to say yes.
 *
 * The three-way answer is the whole point. A binary allow/refuse forces the
 * allowlist to be either too tight to build anything or too loose to be a
 * guard; a middle verdict lets PowerShell exist without the list becoming
 * decorative, because the dangerous half of what it can express stops and asks.
 *
 * @param {string} command
 * @param {{mode?: 'allowlist'|'unrestricted', allowed?: string[], confirm?: 'destructive'|'all'|'none'}} [options]
 * @returns {{verdict: 'allow'|'confirm'|'refuse', reason?: string}}
 */
export function classifyCommand(command, options = {}) {
  const text = String(command || '').trim();
  const confirm = CONFIRM_MODES.includes(options.confirm) ? options.confirm : 'destructive';

  if (!text) return { verdict: 'refuse', reason: 'Empty command.' };
  if (text.length > 4000) return { verdict: 'refuse', reason: 'Command is too long.' };

  // The denylist runs against the whole line first, because some of the
  // patterns span what the splitter would treat as separate segments.
  for (const { re, why } of DENY_PATTERNS) {
    if (re.test(text)) return { verdict: 'refuse', reason: `Refused: ${why}.` };
  }

  const segments = splitSegments(text);

  for (const segment of segments) {
    for (const { re, why } of DENY_PATTERNS) {
      if (re.test(segment)) return { verdict: 'refuse', reason: `Refused: ${why}.` };
    }
    // Escalation is refused everywhere. There is no confirmation that makes
    // handing Oscar administrator rights a good idea, so this is not a gate.
    const program = programOf(segment);
    if (NEVER_ALLOWED.includes(program)) {
      return { verdict: 'refuse', reason: `Refused: ${program} runs as another user.` };
    }
  }

  if (options.mode !== 'unrestricted') {
    const allowed = new Set((options.allowed || DEFAULT_ALLOWED).map((s) => String(s).toLowerCase()));
    for (const segment of segments) {
      const program = programOf(segment);
      if (!program) continue;
      if (!allowed.has(program)) {
        return {
          verdict: 'refuse',
          reason:
            `Refused: "${program}" is not on the allowlist. ` +
            'Add it with --allow, or start the runner with --unrestricted.',
        };
      }
    }
  }

  if (confirm === 'none') return { verdict: 'allow' };
  if (confirm === 'all') return { verdict: 'confirm', reason: 'every command is set to ask first' };

  for (const { re, why } of DESTRUCTIVE_PATTERNS) {
    if (re.test(text)) return { verdict: 'confirm', reason: why };
  }

  return { verdict: 'allow' };
}

/**
 * The old binary question, kept for the server's courtesy check.
 *
 * `confirm` counts as ok here on purpose: this is used by lib/tools/shell.js to
 * give the model a fast "no" for things that could never run, and a command
 * awaiting your approval is not one of them. Refusing it server-side would mean
 * you were never asked.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkCommand(command, options = {}) {
  const { verdict, reason } = classifyCommand(command, options);
  return verdict === 'refuse' ? { ok: false, reason } : { ok: true, reason };
}
