/**
 * public/app.js
 * ----------------------------------------------------------------------------
 * Browser-side console, with the two-step login in front of it.
 *
 * Worth being clear about what this file does and doesn't do: hiding the
 * console until you're signed in is a convenience, not the security boundary.
 * The real boundary is server-side — /api/ask refuses to answer without a valid
 * session cookie or the Shortcut key. This page holds no secrets, so it doesn't
 * matter that anyone can read it.
 *
 * The session cookie is HttpOnly, so this script can't read it either. That's
 * deliberate: it means an XSS bug can't steal your session. We ask the server
 * "am I signed in?" via /api/session instead.
 */

const $ = (id) => document.getElementById(id);

const el = {
  viewLoading: $('view-loading'),
  viewLogin: $('view-login'),
  viewApp: $('view-app'),

  subtitle: $('subtitle'),
  health: $('health'),
  signout: $('signout'),

  stepPassword: $('step-password'),
  stepCode: $('step-code'),
  password: $('password'),
  passwordSubmit: $('password-submit'),
  code: $('code'),
  codeSubmit: $('code-submit'),
  sentTo: $('sent-to'),
  countdown: $('countdown'),
  restart: $('restart'),
  gateError: $('gate-error'),
  gateNote: $('gate-note'),

  tabAsk: $('tab-ask'),
  tabHistory: $('tab-history'),
  paneAsk: $('pane-ask'),
  paneHistory: $('pane-history'),
  search: $('search'),
  refresh: $('refresh'),
  historyMeta: $('history-meta'),
  historyList: $('history-list'),

  question: $('question'),
  mic: $('mic'),
  send: $('send'),
  result: $('result'),
  confirmRow: $('confirm-row'),
  confirmNote: $('confirm-note'),
  confirmYes: $('confirm-yes'),
  confirmNo: $('confirm-no'),
  title: $('r-title'),
  answer: $('r-answer'),
  detail: $('r-detail'),
  meta: $('r-meta'),
  activityStatus: $('activity-status'),
  activityLog: $('activity-log'),
  recipe: $('recipe'),
  copy: $('copy'),
  endpoint: $('endpoint'),
};

const ENDPOINT = new URL('/api/ask', location.origin).toString();

/** `credentials: same-origin` so the session cookie rides along. */
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/* ============================================================== login gate */

let challenge = null;
let countdownTimer = null;

function showGateError(message) {
  el.gateError.textContent = message;
  el.gateError.hidden = !message;
}

function showGateNote(message) {
  el.gateNote.textContent = message;
  el.gateNote.hidden = !message;
}

function startCountdown(ms) {
  clearInterval(countdownTimer);
  let remaining = Math.floor(ms / 1000);

  const tick = () => {
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      el.countdown.textContent = '0:00';
      showGateError('That code expired. Start over.');
      resetGate();
      return;
    }
    const m = Math.floor(remaining / 60);
    const s = String(remaining % 60).padStart(2, '0');
    el.countdown.textContent = `${m}:${s}`;
    remaining--;
  };

  tick();
  countdownTimer = setInterval(tick, 1000);
}

function resetGate() {
  clearInterval(countdownTimer);
  challenge = null;
  el.stepCode.hidden = true;
  el.stepPassword.hidden = false;
  el.code.value = '';
  el.password.value = '';
  el.password.focus();
}

el.stepPassword.addEventListener('submit', async (event) => {
  event.preventDefault();
  showGateError('');
  showGateNote('');
  el.passwordSubmit.disabled = true;
  el.passwordSubmit.textContent = 'Sending…';

  try {
    const { res, data } = await api('/api/auth', {
      action: 'start',
      password: el.password.value,
    });

    if (!res.ok || !data.ok) {
      showGateError(data.error || `Sign-in failed (HTTP ${res.status}).`);
      return;
    }

    challenge = data.challenge;
    el.sentTo.textContent = data.sentTo || 'your email';
    el.stepPassword.hidden = true;
    el.stepCode.hidden = false;
    el.code.focus();
    startCountdown(data.expiresInMs || 600000);

    if (data.delivered === false) {
      showGateNote(
        'No email provider is configured yet, so the code was written to your Vercel ' +
          'function logs instead (Vercel → your project → Logs). Set RESEND_API_KEY to ' +
          'receive it by email.'
      );
    }
  } catch (err) {
    showGateError(String((err && err.message) || err));
  } finally {
    el.passwordSubmit.disabled = false;
    el.passwordSubmit.textContent = 'Send code';
  }
});

el.stepCode.addEventListener('submit', async (event) => {
  event.preventDefault();
  showGateError('');
  el.codeSubmit.disabled = true;
  el.codeSubmit.textContent = 'Checking…';

  try {
    const { res, data } = await api('/api/auth', {
      action: 'verify',
      challenge,
      code: el.code.value,
    });

    if (!res.ok || !data.ok) {
      showGateError(data.error || `Verification failed (HTTP ${res.status}).`);
      el.code.select();
      return;
    }

    clearInterval(countdownTimer);
    await enterConsole(data.email);
  } catch (err) {
    showGateError(String((err && err.message) || err));
  } finally {
    el.codeSubmit.disabled = false;
    el.codeSubmit.textContent = 'Verify';
  }
});

el.restart.addEventListener('click', () => {
  showGateError('');
  showGateNote('');
  resetGate();
});

// Uppercase as you type, and auto-submit once the code is complete — the code
// is 6 characters, so waiting for a button press is just friction.
el.code.addEventListener('input', () => {
  const cleaned = el.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned !== el.code.value) el.code.value = cleaned;
  if (cleaned.length === 6 && !el.codeSubmit.disabled) {
    el.stepCode.requestSubmit();
  }
});

el.signout.addEventListener('click', async () => {
  el.signout.disabled = true;
  await api('/api/auth', { action: 'logout' });
  resetGate();
  showGateError('');
  showGateNote('');
  showGate();
  el.signout.disabled = false;
});

/* ============================================================ view switching */

/**
 * The page has exactly three states, and this is the only thing that changes
 * them. Everything else calls setState() rather than toggling elements itself
 * — which is what guarantees the console cannot be on screen while signed out.
 *
 * `hidden` handles it for assistive tech and for JS-driven changes; the
 * matching CSS rules on body[data-state] handle it before JS has even run.
 *
 * @param {'loading'|'out'|'in'} state
 */
function setState(state) {
  document.body.dataset.state = state;
  el.viewLoading.hidden = state !== 'loading';
  el.viewLogin.hidden = state !== 'out';
  el.viewApp.hidden = state !== 'in';
}

async function enterConsole(email) {
  setState('in');
  el.subtitle.textContent = email
    ? `Signed in as ${email}.`
    : 'Signed in. This calls the same endpoint your Shortcut does.';

  // Populated only now, so the endpoint URL never appears on the login screen.
  el.endpoint.textContent = ENDPOINT;
  el.recipe.textContent = recipeText();

  el.question.focus();
  await checkHealth();
}

function showGate() {
  setState('out');

  // Clear anything the app view had rendered, so a signed-out page holds no
  // trace of the previous session even before a reload.
  el.endpoint.textContent = '';
  el.recipe.textContent = '';
  el.historyList.replaceChildren();
  el.result.hidden = true;
  historyLoaded = false;

  el.password.focus();
}

/* --------------------------------------------------------------------- init */

function recipeText() {
  return [
    'Get Contents of URL',
    `  URL     ${ENDPOINT}`,
    '  Method  POST',
    '  Headers x-oscar-key : <your OSCAR_SHARED_SECRET>',
    '  Body    JSON',
    '    question (Text) : Dictated Text',
    '    tz       (Text) : ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  ].join('\n');
}

async function init() {
  setState('loading');

  try {
    const { data } = await api('/api/session');
    if (data.authed) await enterConsole(data.email);
    else showGate();
  } catch {
    showGate();
    showGateError('Could not reach the server.');
  }
}

/* ------------------------------------------------------------------- health */

async function checkHealth() {
  try {
    const { data } = await api('/api/health');
    if (data.agent && data.agent.openaiKey) {
      el.health.dataset.state = 'ok';
      el.health.textContent = String(data.agent.model).replace(' (default)', '');
    } else {
      el.health.dataset.state = 'bad';
      el.health.textContent = 'no API key';
    }
  } catch {
    el.health.dataset.state = 'bad';
    el.health.textContent = 'api unreachable';
  }
}

/* ---------------------------------------------------------------- rendering */

function render({ ok, title, answer, detail, meta }) {
  el.result.hidden = false;
  // Any new render clears a stale pending confirmation. Leaving an old Yes
  // button on screen next to a new answer is how people delete the wrong thing.
  hideConfirm();
  el.result.classList.toggle('error', !ok);
  el.title.textContent = title || 'Oscar';
  el.answer.textContent = answer || '';
  el.detail.textContent = detail || '';
  el.detail.hidden = !detail;
  el.meta.textContent = meta || '';
  el.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* -------------------------------------------------------------------- asking */

let inFlight = false;

/**
 * Set by the mic handler, cleared on every send.
 *
 * The server skips the confirmation step for typed web input but not for
 * dictation, so it needs to know which this was — and only this page can tell.
 */
let cameFromMic = false;

async function ask() {
  const question = el.question.value.trim();
  if (!question || inFlight) return;

  inFlight = true;
  el.send.disabled = true;
  el.send.textContent = 'Thinking…';
  render({ ok: true, title: 'Working…', answer: question, meta: '' });

  stopWatching();
  clearLog();
  setActivity('working', 'thinking');
  logLine(question, { kind: 'note' });

  const started = performance.now();

  try {
    const { res, data } = await api('/api/ask', {
      question,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    // The session expired while the page was open.
    if (res.status === 401) {
      showGate();
      showGateError('Your session expired. Sign in again.');
      return;
    }

    const roundTrip = Math.round(performance.now() - started);

    // A new row exists now, so the history tab should refetch next time it opens.
    historyLoaded = false;

    render({
      ok: Boolean(data.ok),
      title: data.title || 'Oscar failed',
      answer: data.answer || `Server returned ${res.status}.`,
      detail: data.detail,
      meta: data.ok
        ? `${data.model || 'model'} · ${data.elapsedMs ?? '?'}ms model · ${roundTrip}ms round trip`
        : `HTTP ${res.status} · ${roundTrip}ms`,
    });

    // render() clears any previous confirmation, so this has to come after it.
    if (data.needsConfirmation) showConfirm(data);

    if (data.async && data.jobId) {
      // Heavy work. The server is already running it; follow along.
      logLine('handed off to a background job', {
        kind: 'note',
        how: `${data.mode} · routed by ${data.routedBy}`,
      });
      watchJob(data.jobId, data.jobToken);
    } else {
      for (const name of data.tools || []) logLine(name, { how: 'tool' });
      setActivity(data.ok ? 'done' : 'bad', data.ok ? `done · ${data.rounds || 1} rounds` : 'failed');
      if (data.mode) {
        logLine(`answered inline`, { kind: 'note', how: `${data.mode} · ${data.model || ''}`.trim() });
      }
    }
  } catch (err) {
    render({ ok: false, title: 'Network error', answer: String((err && err.message) || err) });
  } finally {
    inFlight = false;
    cameFromMic = false;
    el.send.disabled = false;
    el.send.textContent = 'Ask Oscar';
  }
}

/* ================================================== Oscar's thinking */

/**
 * The shell. When a question is heavy enough to become a background job, the
 * work is NOT held open on an HTTP connection — it runs server-side across as
 * many invocations as it needs, and this panel watches it.
 *
 * Everything is mirrored to console.log too, so the browser devtools give you
 * the same trace without the UI.
 */

let pollTimer = null;
let watchingJob = null;

function setActivity(state, label) {
  el.activityStatus.dataset.state = state;
  el.activityStatus.textContent = label;
}

function clearLog() {
  el.activityLog.replaceChildren();
}

/**
 * Built with createElement, not innerHTML: tool names and error text come from
 * the server, and textContent cannot be tricked into executing markup.
 */
function logLine(what, { kind = '', how = '' } = {}) {
  const li = document.createElement('li');
  if (kind) li.className = kind;

  const tick = document.createElement('span');
  tick.className = 'tick';
  tick.textContent = new Date().toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).replace(/^(\d)/, '0$1').slice(-8);

  const body = document.createElement('span');
  body.className = 'what';
  body.textContent = what;

  const note = document.createElement('span');
  note.className = 'how';
  note.textContent = how;

  li.append(tick, body, note);
  el.activityLog.appendChild(li);
  el.activityLog.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  console.log(`[oscar] ${what}${how ? ` — ${how}` : ''}`);
  return li;
}

function stopWatching() {
  clearTimeout(pollTimer);
  pollTimer = null;
  watchingJob = null;
}

/** Render tool events we have not already shown. */
function renderEvents(events, alreadyShown) {
  let shown = alreadyShown;
  for (let i = alreadyShown; i < events.length; i++) {
    const e = events[i];
    logLine(e.ok ? `${e.tool}` : `${e.tool} failed`, {
      kind: e.ok ? '' : 'bad',
      how: e.ok ? `round ${e.round}` : e.detail || '',
    });
    shown = i + 1;
  }
  return shown;
}

/**
 * Poll a background job until it finishes.
 *
 * Polling rather than a socket on purpose: it survives the tab being
 * backgrounded, reconnects for free, and needs no server-side connection state.
 * Each poll also nudges the job along if its self-continuation was ever lost —
 * which is why a dropped hop is recoverable rather than fatal.
 */
async function watchJob(jobId, token) {
  stopWatching();
  watchingJob = jobId;

  let shown = 0;
  const startedAt = Date.now();
  const GIVE_UP_AFTER = 5 * 60 * 1000;

  const tick = async () => {
    if (watchingJob !== jobId) return;

    try {
      const query = new URLSearchParams({ id: jobId });
      if (token) query.set('token', token);
      const { data } = await api(`/api/jobs?${query}`);
      const job = data.job;
      if (!job) throw new Error(data.error || 'Job not found.');

      shown = renderEvents(job.events || [], shown);

      if (job.status === 'done') {
        setActivity('done', `done · ${job.steps} steps`);
        logLine('finished', { kind: 'note', how: `${job.steps} steps` });
        render({
          ok: true,
          title: job.title || 'Done',
          answer: job.answer || '',
          detail: job.detail,
          meta: `${job.model || 'model'} · ${job.steps} steps · background job`,
        });
        historyLoaded = false;
        return stopWatching();
      }

      if (job.status === 'awaiting_confirm') {
        setActivity('working', 'waiting on you');
        logLine('needs your confirmation', { kind: 'note' });
        render({ ok: true, title: job.title || 'Confirm', answer: job.answer || '' });
        if (job.pendingConfirmation) {
          showConfirm({ confirmToken: null, confirmExpiresInSeconds: 300 });
        }
        return stopWatching();
      }

      if (job.status === 'failed') {
        setActivity('bad', 'failed');
        logLine(job.error || 'failed', { kind: 'bad' });
        render({ ok: false, title: 'Oscar failed', answer: job.error || 'The job failed.' });
        return stopWatching();
      }

      setActivity('working', `${job.status} · ${job.steps} steps`);

      if (Date.now() - startedAt > GIVE_UP_AFTER) {
        setActivity('bad', 'gave up watching');
        logLine('stopped watching after five minutes — the job may still finish', { kind: 'note' });
        return stopWatching();
      }

      pollTimer = setTimeout(tick, 1200);
    } catch (err) {
      logLine(String((err && err.message) || err), { kind: 'bad' });
      setActivity('bad', 'lost the job');
      stopWatching();
    }
  };

  tick();
}

/* ====================================================== confirmations */

/**
 * A destructive action is waiting on a yes/no. The token from the server
 * describes exactly what was proposed and is signed, so this page cannot change
 * what it applies to — it can only relay a yes or a no.
 */
let pendingToken = null;

function hideConfirm() {
  pendingToken = null;
  el.confirmRow.hidden = true;
}

function showConfirm(data) {
  pendingToken = data.confirmToken;
  el.confirmNote.textContent = `Expires in ${Math.round(
    (data.confirmExpiresInSeconds || 300) / 60
  )} minutes. Nothing has happened yet.`;
  el.confirmRow.hidden = false;
  el.confirmYes.disabled = false;
  el.confirmNo.disabled = false;
  el.confirmYes.focus();
}

async function resolveConfirm(agreed) {
  if (!pendingToken) return;

  const token = pendingToken;
  el.confirmYes.disabled = true;
  el.confirmNo.disabled = true;
  el.confirmYes.textContent = agreed ? 'Deleting…' : 'Yes, delete';

  try {
    const { res, data } = await api('/api/confirm', { token, confirm: agreed });
    render({
      ok: Boolean(data.ok),
      title: data.title || (agreed ? 'Done' : 'Cancelled'),
      answer: data.answer || '',
      meta: data.ok ? '' : `HTTP ${res.status}`,
    });
    historyLoaded = false;
  } catch (err) {
    render({ ok: false, title: 'Network error', answer: String((err && err.message) || err) });
  } finally {
    el.confirmYes.textContent = 'Yes, delete';
  }
}

el.confirmYes.addEventListener('click', () => resolveConfirm(true));
el.confirmNo.addEventListener('click', () => resolveConfirm(false));

/* ============================================================ history tab */

let historyLoaded = false;

function showTab(which) {
  const history = which === 'history';
  el.tabAsk.classList.toggle('on', !history);
  el.tabHistory.classList.toggle('on', history);
  el.tabAsk.setAttribute('aria-selected', String(!history));
  el.tabHistory.setAttribute('aria-selected', String(history));
  el.paneAsk.hidden = history;
  el.paneHistory.hidden = !history;

  if (history && !historyLoaded) loadHistory();
}

/** Local time, and a relative hint for anything recent. */
function formatWhen(iso) {
  const when = new Date(iso);
  const mins = Math.round((Date.now() - when.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Built with createElement rather than innerHTML on purpose: these strings come
 * back from a database, and textContent can't be tricked into executing markup.
 */
function entryNode(row) {
  const node = document.createElement('article');
  node.className = `entry${row.ok ? '' : ' bad'}`;

  const question = document.createElement('div');
  question.className = 'entry-q';
  question.textContent = row.question || '(empty)';

  const answer = document.createElement('div');
  answer.className = 'entry-a';
  answer.textContent = row.ok ? row.answer || '' : row.error || 'failed';

  const meta = document.createElement('div');
  meta.className = 'entry-meta';

  const bits = [
    formatWhen(row.created_at),
    row.source || row.via,
    row.model,
    row.total_ms ? `${row.total_ms}ms` : null,
    row.total_tokens ? `${row.total_tokens} tokens` : null,
  ].filter(Boolean);

  for (const bit of bits) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = bit;
    meta.appendChild(tag);
  }

  node.append(question, answer, meta);

  if (row.detail) {
    const detail = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'more';
    summary.className = 'meta';
    const body = document.createElement('div');
    body.className = 'entry-a';
    body.textContent = row.detail;
    detail.append(summary, body);
    node.insertBefore(detail, meta);
  }

  return node;
}

async function loadHistory() {
  el.historyMeta.textContent = 'Loading…';
  el.historyList.replaceChildren();

  const params = new URLSearchParams({ limit: '50' });
  const term = el.search.value.trim();
  if (term) params.set('q', term);

  try {
    const { res, data } = await api(`/api/history?${params}`);

    if (res.status === 401) {
      showGate();
      showGateError('Your session expired. Sign in again.');
      return;
    }

    historyLoaded = true;

    if (data.configured === false) {
      el.historyMeta.textContent = '';
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent =
        'No database configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel to start logging — see SUPABASE.md.';
      el.historyList.appendChild(empty);
      return;
    }

    if (!data.ok) {
      el.historyMeta.textContent = data.error || 'Could not load history.';
      return;
    }

    const rows = data.rows || [];
    el.historyMeta.textContent = rows.length
      ? `${rows.length} most recent${term ? ` matching “${term}”` : ''}`
      : '';

    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = term ? 'Nothing matches that search.' : 'Nothing logged yet. Ask something.';
      el.historyList.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.appendChild(entryNode(row));
    el.historyList.appendChild(fragment);
  } catch (err) {
    el.historyMeta.textContent = String((err && err.message) || err);
  }
}

// Debounced so typing doesn't fire a query per keystroke.
let searchTimer = null;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 300);
});

el.refresh.addEventListener('click', loadHistory);
el.tabAsk.addEventListener('click', () => showTab('ask'));
el.tabHistory.addEventListener('click', () => showTab('history'));

/* ------------------------------------------------------ dictation (optional) */
// Web Speech API where it exists (Chrome, Safari). Convenience for testing in a
// browser — on the phone, Shortcuts does the dictation and never loads this file.

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    el.mic.disabled = true;
    el.mic.title = 'This browser has no speech recognition — type instead';
    return;
  }

  const recognizer = new SR();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.interimResults = true;
  recognizer.continuous = false;

  let base = '';

  recognizer.onstart = () => {
    base = el.question.value ? el.question.value.trim() + ' ' : '';
    el.mic.classList.add('on');
  };

  recognizer.onresult = (event) => {
    let text = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      text += event.results[i][0].transcript;
    }
    el.question.value = base + text.trim();
  };

  recognizer.onerror = () => el.mic.classList.remove('on');

  recognizer.onend = () => {
    el.mic.classList.remove('on');
    if (el.question.value.trim()) {
      cameFromMic = true;
      ask();
    }
  };

  el.mic.addEventListener('click', () => {
    if (el.mic.classList.contains('on')) recognizer.stop();
    else {
      try {
        recognizer.start();
      } catch {
        /* already running */
      }
    }
  });
}

/* ------------------------------------------------------------------- wiring */

el.send.addEventListener('click', ask);

el.question.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ask();
});

// Editing a dictated draft means you've read it on screen, so it stops counting
// as dictation. Modifier-only presses don't count as editing.
el.question.addEventListener('input', () => {
  cameFromMic = false;
});

el.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(ENDPOINT);
    el.copy.textContent = 'Copied';
    setTimeout(() => (el.copy.textContent = 'Copy endpoint URL'), 1400);
  } catch {
    el.copy.textContent = 'Copy failed — select it below';
  }
});

setupMic();
init();
