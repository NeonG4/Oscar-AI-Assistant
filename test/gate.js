/**
 * test/gate.js
 * ----------------------------------------------------------------------------
 * The confirmation gate, end to end.
 *
 *   npm run test:gate
 *
 * Separate from smoke.js because this spawns the real scripts/runner.js as a
 * child process and talks to it over a real socket, which takes half a minute.
 * It is worth that: the gate is the thing standing between a misheard sentence
 * and your files, and the unit tests in smoke.js only prove that
 * classifyCommand returns the right word. They cannot prove the runner acts on
 * it — that it actually holds, actually asks, and actually declines to run when
 * the answer is no or never comes.
 *
 * The stand-in server is deliberately dumb. It hands out one command, records
 * what the runner asks for, and answers however the scenario says. Nothing here
 * touches the deployment or the database.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

const SECRET = 'test-secret';

function runScenario({ name, command, answer, expect, policy = null, pinned = true }) {
  return new Promise((resolve) => {
    const log = [];
    let questionAsked = null;
    let settled = null;

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body || '{}');
        const reply = (o) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, ...o }));
        };

        if (req.headers['x-oscar-runner'] !== SECRET) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ ok: false, error: 'Not authorised.' }));
        }

        if (msg.action === 'claim') {
          if (questionAsked === null && settled === null && !server.handedOut) {
            server.handedOut = true;
            return reply({ command: { id: 'cmd-1', command, timeoutMs: 15000 }, policy });
          }
          return reply({ command: null, policy });
        }
        if (msg.action === 'confirm') {
          questionAsked = { why: msg.why, runner: msg.runner };
          return reply({ questionId: 'q-1', delivered: true });
        }
        if (msg.action === 'confirm-status') {
          if (answer === null) return reply({ status: 'pending', answered: false, approved: false });
          return reply({
            status: 'answered',
            answered: true,
            approved: /^\s*y/i.test(answer),
            answer,
          });
        }
        if (msg.action === 'result') {
          settled = msg;
          return reply({ id: msg.id, status: msg.status });
        }
        return reply({});
      });
    });

    server.listen(0, () => {
      const port = server.address().port;
      // Passing --confirm PINS the laptop and makes it ignore the policy, so a
      // scenario testing the website setting must not pass it. That is the
      // whole contract between the two, and getting it backwards here would
      // make these tests pass against a runner that ignored the server.
      const child = spawn(
        process.execPath,
        pinned
          ? ['scripts/runner.js', '--once', '--confirm', 'destructive']
          : ['scripts/runner.js', '--once'],
        {
          env: {
            ...process.env,
            OSCAR_RUNNER_SECRET: SECRET,
            OSCAR_BASE_URL: `http://127.0.0.1:${port}`,
            OSCAR_CONFIRM_TIMEOUT_MS: '6000',
          },
        }
      );

      child.stdout.on('data', (d) => log.push(String(d)));
      child.stderr.on('data', (d) => log.push(String(d)));

      const finish = () => {
        try {
          child.kill();
        } catch {}
        server.close();
        const text = log.join('');
        const ok = expect({ questionAsked, settled, text });
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
        if (!ok) {
          console.log('      asked:', JSON.stringify(questionAsked));
          console.log('      settled:', JSON.stringify(settled));
          console.log(
            '      output:',
            text.split('\n').filter((l) => l.trim()).slice(-6).join(' | ')
          );
        }
        resolve(ok);
      };

      child.on('exit', finish);
      setTimeout(finish, 25000);
    });
  });
}

const results = [];

results.push(
  await runScenario({
    name: 'a harmless command runs without asking',
    command: 'git --version',
    answer: null,
    expect: ({ questionAsked, settled }) =>
      questionAsked === null && settled && settled.status === 'done' && settled.exitCode === 0,
  })
);

results.push(
  await runScenario({
    name: 'a destructive command asks, and runs on yes',
    command: 'pwsh -c "Remove-Item nothing-here.tmp -ErrorAction SilentlyContinue; Write-Output ran"',
    answer: 'Yes, run it',
    expect: ({ questionAsked, settled, text }) =>
      questionAsked !== null &&
      /deletes files/.test(questionAsked.why || '') &&
      settled &&
      settled.status === 'done' &&
      /ran/.test(settled.stdout || '') &&
      /HELD/.test(text),
  })
);

results.push(
  await runScenario({
    name: 'a destructive command does not run on no',
    command: 'pwsh -c "Remove-Item nothing-here.tmp -ErrorAction SilentlyContinue; Write-Output ran"',
    answer: 'No, cancel it',
    expect: ({ questionAsked, settled }) =>
      questionAsked !== null &&
      settled &&
      settled.status === 'refused' &&
      /you said no/i.test(settled.error || '') &&
      !settled.stdout,
  })
);

results.push(
  await runScenario({
    name: 'silence is a no',
    command: 'pwsh -c "Remove-Item nothing-here.tmp -ErrorAction SilentlyContinue"',
    answer: null,
    expect: ({ questionAsked, settled }) =>
      questionAsked !== null &&
      settled &&
      settled.status === 'refused' &&
      /no answer within/i.test(settled.error || ''),
  })
);

results.push(
  await runScenario({
    name: 'a denylisted command is refused without ever asking',
    command: 'shutdown /s',
    answer: 'Yes, run it',
    expect: ({ questionAsked, settled }) =>
      questionAsked === null && settled && settled.status === 'refused',
  })
);

/* ---------------------------------------------------- the website setting */

results.push(
  await runScenario({
    name: 'policy open lets a destructive command through without asking',
    command: 'pwsh -c "Remove-Item nothing-here.tmp -ErrorAction SilentlyContinue; Write-Output ran"',
    policy: 'open',
    pinned: false,
    answer: null,
    expect: ({ questionAsked, settled }) =>
      questionAsked === null && settled && settled.status === 'done' && /ran/.test(settled.stdout || ''),
  })
);

results.push(
  await runScenario({
    name: 'policy confirm makes even a harmless command ask',
    command: 'git --version',
    policy: 'confirm',
    pinned: false,
    answer: 'Yes, run it',
    expect: ({ questionAsked, settled }) =>
      questionAsked !== null && settled && settled.status === 'done',
  })
);

results.push(
  await runScenario({
    name: 'policy destructive leaves a harmless command alone',
    command: 'git --version',
    policy: 'destructive',
    pinned: false,
    answer: null,
    expect: ({ questionAsked, settled }) =>
      questionAsked === null && settled && settled.status === 'done',
  })
);

results.push(
  await runScenario({
    name: 'a pinned runner ignores a looser website setting',
    command: 'pwsh -c "Remove-Item nothing-here.tmp -ErrorAction SilentlyContinue"',
    policy: 'open',
    pinned: true,
    answer: 'No, cancel it',
    expect: ({ questionAsked, settled }) =>
      questionAsked !== null && settled && settled.status === 'refused',
  })
);

console.log(`\n${results.filter(Boolean).length}/${results.length} passing`);
process.exit(results.every(Boolean) ? 0 : 1);
