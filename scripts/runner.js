/**
 * scripts/runner.js
 * ----------------------------------------------------------------------------
 * The half of Oscar that lives on your computer.
 *
 *   npm run runner                     -- allowlisted commands only
 *   npm run runner -- --unrestricted   -- anything but the denylist
 *   npm run runner -- --root ~/code    -- pin it to one directory tree
 *
 * It polls your deployment, claims one command at a time, runs it in a real
 * shell, and posts the output back. Nothing listens on a port and nothing is
 * exposed to the internet: every connection is outbound, which is why this
 * works from behind NAT, on hotel wifi, without touching your router.
 *
 * THIS FILE IS THE SECURITY BOUNDARY
 *
 * Everything upstream — the model, the database, the API — decides what to ASK
 * for. This decides what RUNS. It re-checks every command against
 * lib/shell-policy.js locally, so a compromised deployment, a poisoned database
 * row or a model talked into something still meets a flat "no" here. That is
 * the entire point of doing the check twice.
 *
 * Two more limits worth knowing about:
 *
 *   - Every command is confined to --root. A `cwd` that resolves outside it is
 *     refused rather than clamped, because silently running somewhere other
 *     than where you were told is worse than failing.
 *   - Nothing runs with elevated privileges. If you started this as an ordinary
 *     user, that is all it can ever be. Do not run it as administrator.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkCommand, DEFAULT_ALLOWED } from '../lib/shell-policy.js';

/* --------------------------------------------------------------- .env.local */

function loadEnvFile() {
  try {
    const text = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env.local, that's fine */
  }
}

loadEnvFile();

/* ------------------------------------------------------------------- config */

function parseArgs(argv) {
  const opts = {
    mode: 'allowlist',
    root: process.env.OSCAR_RUNNER_ROOT || process.cwd(),
    interval: Number(process.env.OSCAR_RUNNER_INTERVAL_MS) || 3000,
    allow: [...DEFAULT_ALLOWED],
    once: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const valueOf = () => (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : '');

    if (arg === '--unrestricted') opts.mode = 'unrestricted';
    else if (arg === '--once') opts.once = true;
    else if (arg === '--root') opts.root = valueOf() || opts.root;
    else if (arg === '--interval') opts.interval = Number(valueOf()) || opts.interval;
    else if (arg === '--allow') opts.allow.push(...valueOf().split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }

  opts.root = path.resolve(opts.root.replace(/^~(?=$|[/\\])/, os.homedir()));
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`
Oscar runner — lets Oscar run commands on this machine.

  npm run runner                        allowlisted programs only (default)
  npm run runner -- --unrestricted      anything except the denylist
  npm run runner -- --root <dir>        confine commands to this tree
  npm run runner -- --allow docker,psql add programs to the allowlist
  npm run runner -- --interval 5000     how often to poll, in ms
  npm run runner -- --once              claim at most one command, then exit

Needs OSCAR_RUNNER_SECRET and OSCAR_BASE_URL, from the environment or .env.local.
`);
  process.exit(0);
}

const SECRET = (process.env.OSCAR_RUNNER_SECRET || '').trim();
const BASE = (process.env.OSCAR_BASE_URL || process.env.OSCAR_URL || '').trim().replace(/\/+$/, '');

if (!SECRET) {
  console.error('No OSCAR_RUNNER_SECRET. Generate one, set it in Vercel and in .env.local, redeploy.');
  process.exit(1);
}
if (!BASE) {
  console.error('No OSCAR_BASE_URL. Set it to your deployment, e.g. https://your-app.vercel.app');
  process.exit(1);
}

const ENDPOINT = `${BASE}/api/runner`;
const HOSTNAME = os.hostname();
const MAX_OUTPUT = 20000;

/* ------------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stamp = () => new Date().toLocaleTimeString();

async function post(payload) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oscar-runner': SECRET },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Unreadable reply (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Keep both ends — a failure is usually visible at the start or the very end. */
function clamp(text) {
  const s = String(text || '');
  if (s.length <= MAX_OUTPUT) return s;
  const half = Math.floor(MAX_OUTPUT / 2);
  return `${s.slice(0, half)}\n\n... [${s.length - MAX_OUTPUT} characters trimmed] ...\n\n${s.slice(-half)}`;
}

/**
 * Where this command is allowed to run.
 *
 * Refuses rather than clamps when the target escapes the root: a command that
 * asked for one directory and silently got another produces results that look
 * right and aren't, which is the worst kind of wrong.
 */
function resolveCwd(requested) {
  if (!requested) return opts.root;

  const expanded = String(requested).replace(/^~(?=$|[/\\])/, os.homedir());
  const target = path.resolve(opts.root, expanded);
  const rel = path.relative(opts.root, target);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refused: ${requested} is outside the runner's root (${opts.root}).`);
  }
  if (!fs.existsSync(target)) throw new Error(`No such directory: ${target}`);
  return target;
}

/* --------------------------------------------------------------- execution */

function execute(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    // `shell: true` with the command as ONE string, rather than assembling
    // cmd.exe /c ourselves. Node then sets windowsVerbatimArguments and hands
    // the line to the shell untouched. Building the argv by hand looks tidier
    // and quietly breaks every embedded quote: `node -e "console.log(1)"`
    // arrives with the quotes escaped for a shell that doesn't want them, runs
    // nothing, and still exits 0 — a silent wrong answer, which is the worst
    // failure mode available here.
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, OSCAR_RUNNER: '1' },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += chunk;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'failed', exitCode: null, stdout, stderr, error: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          status: 'failed',
          exitCode: null,
          stdout: clamp(stdout),
          stderr: clamp(stderr),
          error: `Timed out after ${timeoutMs}ms and was killed.`,
        });
        return;
      }
      resolve({ status: 'done', exitCode: code, stdout: clamp(stdout), stderr: clamp(stderr) });
    });
  });
}

/* -------------------------------------------------------------- the loop */

async function handle(command) {
  console.log(`\n[${stamp()}] ${command.command}`);
  if (command.reason) console.log(`           (${command.reason})`);

  // The local veto. Everything upstream is a request; this is the decision.
  const verdict = checkCommand(command.command, { mode: opts.mode, allowed: opts.allow });
  if (!verdict.ok) {
    console.log(`           REFUSED — ${verdict.reason}`);
    await post({ action: 'result', id: command.id, status: 'refused', error: verdict.reason });
    return;
  }

  let cwd;
  try {
    cwd = resolveCwd(command.cwd);
  } catch (err) {
    console.log(`           REFUSED — ${err.message}`);
    await post({ action: 'result', id: command.id, status: 'refused', error: err.message });
    return;
  }

  const outcome = await execute(command.command, cwd, command.timeoutMs || 30000);
  const label =
    outcome.status === 'done' && outcome.exitCode === 0
      ? 'ok'
      : `exit ${outcome.exitCode === null ? '-' : outcome.exitCode}`;
  console.log(`           ${label}${outcome.error ? ` — ${outcome.error}` : ''}`);

  await post({ action: 'result', id: command.id, ...outcome });
}

async function main() {
  console.log(`Oscar runner on ${HOSTNAME}`);
  console.log(`  deployment  ${BASE}`);
  console.log(`  root        ${opts.root}`);
  console.log(
    `  mode        ${opts.mode}${opts.mode === 'allowlist' ? ` (${opts.allow.length} programs)` : ' — denylist only'}`
  );
  console.log('\nWaiting for commands. Ctrl-C to stop.');

  let quiet = 0;

  for (;;) {
    try {
      const { command } = await post({ action: 'claim', runner: HOSTNAME });
      if (command) {
        quiet = 0;
        await handle(command);
        if (opts.once) return;
        continue;
      }
      // Nothing waiting. Back off gently so an idle laptop isn't polling hard.
      quiet = Math.min(quiet + 1, 5);
    } catch (err) {
      console.error(`[${stamp()}] ${err.message}`);
      quiet = 5;
    }
    await sleep(opts.interval * (1 + quiet * 0.5));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
