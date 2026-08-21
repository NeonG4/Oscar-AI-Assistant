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
 *
 * FOUR PANES, ONE AT A TIME
 *
 *   ask       the conversation, plus Oscar's thinking while he has one
 *   jobs      work too heavy to answer on the end of a request
 *   history   every exchange, grouped back into the threads they happened in
 *   settings  how much of the machinery you want to see, and notifications
 *
 * Everything rendered from server data is built with createElement and
 * textContent, never innerHTML. Questions, answers and tool names all pass
 * through a model and a database on their way here, which makes them exactly
 * the kind of content that must never be parsed as markup.
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
  tabJobs: $('tab-jobs'),
  tabHistory: $('tab-history'),
  tabSettings: $('tab-settings'),
  paneAsk: $('pane-ask'),
  paneJobs: $('pane-jobs'),
  paneHistory: $('pane-history'),
  paneSettings: $('pane-settings'),

  thread: $('thread'),
  threadEmpty: $('thread-empty'),
  question: $('question'),
  mic: $('mic'),
  send: $('send'),
  newChat: $('new-chat'),

  confirmRow: $('confirm-row'),
  confirmNote: $('confirm-note'),
  confirmYes: $('confirm-yes'),
  confirmNo: $('confirm-no'),

  activityStatus: $('activity-status'),
  activityLog: $('activity-log'),
  activityEmpty: $('activity-empty'),
  taskPanel: $('task-panel'),
  taskList: $('task-list'),
  taskProgress: $('task-progress'),

  jobsMeta: $('jobs-meta'),
  jobsList: $('jobs-list'),
  jobsRefresh: $('jobs-refresh'),
  jobsBadge: $('jobs-badge'),

  search: $('search'),
  refresh: $('refresh'),
  historyMeta: $('history-meta'),
  historyList: $('history-list'),

  setDetailed: $('set-detailed'),
  setModel: $('set-model'),
  setTiming: $('set-timing'),
  setCommandPolicy: $('set-command-policy'),
  commandPolicyNote: $('command-policy-note'),
  setCatching: $('set-catching'),
  catchingNote: $('catching-note'),

  recipe: $('recipe'),
  copy: $('copy'),
  endpoint: $('endpoint'),

  questionsCard: $('questions-card'),
  questionsList: $('questions-list'),

  pushDetails: $('push-details'),
  pushStatus: $('push-status'),
  pushEnable: $('push-enable'),
  pushTest: $('push-test'),
  pushHint: $('push-hint'),
};

const ENDPOINT = new URL('/api/ask', location.origin).toString();

/** `credentials: same-origin` so the session cookie rides along. */
async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/* =============================================================== settings */

/**
 * How much of the machinery you want to see.
 *
 * Deliberately local to the browser rather than stored server-side: none of it
 * changes what Oscar does, only what this screen shows, and a preference that
 * needs a round trip to apply is a preference that feels broken.
 *
 * Applied as attributes on <body> so the CSS does the hiding. That matters for
 * anything already on screen — flipping "show the model" re-styles a
 * conversation that is already rendered, instead of needing it rebuilt.
 */
const SETTINGS_KEY = 'oscar.settings';
const DEFAULT_SETTINGS = { detailed: true, model: true, timing: true };

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    settings = { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode, or storage full. The setting still applies for this visit. */
  }
}

function applySettings() {
  document.body.dataset.detailed = settings.detailed ? 'on' : 'off';
  document.body.dataset.model = settings.model ? 'on' : 'off';
  document.body.dataset.timing = settings.timing ? 'on' : 'off';

  el.setDetailed.checked = settings.detailed;
  el.setModel.checked = settings.model;
  el.setTiming.checked = settings.timing;

  renderHealth();
  renderActivityStatus();
  updateActivityEmpty();
}

for (const [key, control] of [
  ['detailed', el.setDetailed],
  ['model', el.setModel],
  ['timing', el.setTiming],
]) {
  control.addEventListener('change', () => {
    settings[key] = control.checked;
    saveSettings();
    applySettings();
  });
}

/* ======================================================= command policy */

/**
 * Whether Oscar may run anything on this machine, and whether it asks first.
 *
 * Server-side for the same reason background catching is: the laptop polling
 * for work at three in the morning cannot read this browser, and neither can
 * the Shortcut. The runner picks the answer up on its next poll, which is
 * within a few seconds — there is nothing to restart.
 *
 * Starts disabled and is only enabled once the server has said what is
 * actually stored. A control you can change before anyone knows its state is
 * a control that lies to you for a second, and this is not the setting to be
 * casual about.
 */
let commandPolicy = null;

const COMMAND_POLICY_NOTES = {
  off: 'Off. Oscar cannot run anything on your computer, and will say so if asked.',
  confirm:
    'Every command asks first. You get a notification, and nothing runs until you say yes.',
  open:
    'Commands run without asking. Your computer still refuses the catastrophic ones — that is not a setting.',
};

function sayCommandPolicy(text, state) {
  el.commandPolicyNote.textContent = text;
  if (state) el.commandPolicyNote.dataset.state = state;
  else delete el.commandPolicyNote.dataset.state;
}

function showCommandPolicy(policy, note) {
  commandPolicy = policy;
  el.setCommandPolicy.value = policy;
  sayCommandPolicy(note || COMMAND_POLICY_NOTES[policy] || policy);
}

async function loadCommandPolicy() {
  el.setCommandPolicy.disabled = true;
  try {
    const { data } = await api('/api/settings');
    if (!data || !data.ok) throw new Error(data && data.error);

    showCommandPolicy(data.commandPolicy);

    if (!data.storable) {
      sayCommandPolicy(
        'No database is configured, so there is nowhere to save this. It is fixed by OSCAR_COMMAND_POLICY.'
      );
      return;
    }

    el.setCommandPolicy.disabled = false;
  } catch (err) {
    sayCommandPolicy(`Could not read this setting: ${(err && err.message) || err}`, 'bad');
  }
}

el.setCommandPolicy.addEventListener('change', async () => {
  const wanted = el.setCommandPolicy.value;
  const previous = commandPolicy;

  el.setCommandPolicy.disabled = true;
  sayCommandPolicy('Saving…', 'saving');

  try {
    const { data } = await api('/api/settings', { commandPolicy: wanted });
    if (!data || !data.ok) throw new Error((data && data.error) || 'it was not saved');
    showCommandPolicy(data.commandPolicy);
  } catch (err) {
    // Put the control back to what is actually stored. Showing a policy the
    // server never accepted is worse than showing an error.
    if (previous !== null) showCommandPolicy(previous);
    sayCommandPolicy(`Not saved: ${(err && err.message) || err}`, 'bad');
  } finally {
    el.setCommandPolicy.disabled = false;
  }
});

/* =================================================== background catching */

/**
 * The one setting on this page that is not about this page.
 *
 * Everything above changes what you see and lives in localStorage. This one
 * decides whether Oscar files away the people you mention, and it has to hold
 * for a Shortcut on a phone and for a job running while this tab is closed —
 * neither of which can read this browser's storage. So it is stored on the
 * server and read back from it, which is why it arrives a moment after the rest
 * of the pane rather than instantly.
 *
 * The checkbox starts DISABLED in the markup's spirit: it is only enabled once
 * the server has said what the stored value actually is. A toggle you can flip
 * before anyone knows its state is a toggle that lies to you for a second.
 */
let catchingOn = null;

function sayCatching(text, state) {
  el.catchingNote.textContent = text;
  if (state) el.catchingNote.dataset.state = state;
  else delete el.catchingNote.dataset.state;
}

function showCatching(on, note) {
  catchingOn = on === true;
  el.setCatching.checked = catchingOn;
  sayCatching(
    note ||
      (catchingOn
        ? 'On. People you mention are saved as you talk. Ask "who do I know" to see them, or "forget Olivia" to remove one.'
        : 'Off. Nobody is recorded unless you ask — "Olivia is my sister, add that to her contact information" still works.')
  );
}

async function loadCatching() {
  el.setCatching.disabled = true;
  try {
    const { data } = await api('/api/settings');
    if (!data || !data.ok) throw new Error(data && data.error);

    showCatching(data.backgroundCatching);

    // No database means there is nowhere to put a person even if one were
    // caught, so the control is left disabled and says why. Better than
    // accepting a click that silently does nothing.
    if (!data.storable) {
      sayCatching(
        'No database is configured, so there is nowhere to keep people. This is fixed by OSCAR_BACKGROUND_CATCHING.'
      );
      return;
    }

    el.setCatching.disabled = false;
  } catch (err) {
    sayCatching(`Could not read this setting: ${(err && err.message) || err}`, 'bad');
  }
}

el.setCatching.addEventListener('change', async () => {
  const wanted = el.setCatching.checked;
  const previous = catchingOn;

  el.setCatching.disabled = true;
  sayCatching('Saving…', 'saving');

  try {
    const { data } = await api('/api/settings', { backgroundCatching: wanted });
    if (!data || !data.ok) throw new Error((data && data.error) || 'it was not saved');
    showCatching(data.backgroundCatching);
  } catch (err) {
    // Put the checkbox back to what is actually stored. A control showing a
    // setting the server never accepted is worse than an error message.
    if (previous !== null) showCatching(previous);
    sayCatching(`Not saved: ${(err && err.message) || err}`, 'bad');
  } finally {
    el.setCatching.disabled = false;
  }
});

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

  // Not awaited: notifications are a nicety, and a slow or failing push setup
  // must never hold up the console being usable.
  setupPush().catch(() => {});

  // Read here rather than in init(), because /api/settings needs a session and
  // the login screen has none. Not awaited either — the Settings tab is not
  // what anyone opens the page for.
  loadCatching().catch(() => {});
  loadCommandPolicy().catch(() => {});

  // This one IS the greeting the whole feature exists for — a suspended run is
  // going nowhere until it is answered.
  loadQuestions().catch(() => {});

  // Quiet first pass so the Jobs tab arrives with its badge already right,
  // rather than looking empty until you tap it.
  loadJobs({ quiet: true }).catch(() => {});
}

function showGate() {
  setState('out');
  stopWatching();
  stopJobsPolling();

  // Clear anything the app view had rendered, so a signed-out page holds no
  // trace of the previous session even before a reload.
  el.endpoint.textContent = '';
  el.recipe.textContent = '';
  el.historyList.replaceChildren();
  el.jobsList.replaceChildren();
  historyLoaded = false;

  newConversation();

  // Neither the device list nor Oscar's open questions belong on a signed-out
  // page — the questions especially, since they describe unfinished work.
  el.pushDetails.hidden = true;
  el.questionsCard.hidden = true;
  el.questionsList.replaceChildren();
  el.jobsBadge.hidden = true;

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
  loadSettings();
  applySettings();
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

let lastHealth = { state: 'unknown', label: 'checking…', model: '' };

/** Re-paints the header pill from `lastHealth`, honouring the model setting. */
function renderHealth() {
  el.health.dataset.state = lastHealth.state;
  el.health.textContent =
    lastHealth.state === 'ok' && !settings.model ? 'ready' : lastHealth.label;
}

async function checkHealth() {
  try {
    const { data } = await api('/api/health');
    if (data.agent && data.agent.openaiKey) {
      const model = String(data.agent.model).replace(' (default)', '');
      lastHealth = { state: 'ok', label: model, model };
    } else {
      lastHealth = { state: 'bad', label: 'no API key', model: '' };
    }
  } catch {
    lastHealth = { state: 'bad', label: 'api unreachable', model: '' };
  }
  renderHealth();
}

/* ============================================================ the conversation */

/**
 * One back-and-forth.
 *
 * The id comes from the server on the first answer and is sent with every
 * follow-up, which is what lets "and what about tomorrow?" work: the server
 * reads the earlier turns of this thread back out of the log and puts them in
 * front of the question. The page deliberately does NOT send the transcript
 * itself — a tab left open for a week would otherwise be able to rewrite what
 * Oscar is told he said.
 */
let conversationId = null;

/** Turn nodes are built here so the two callers can't drift apart. */
function addTurn(role, { text = '', detail = '', ok = true, pending = false } = {}) {
  const node = document.createElement('article');
  node.className = `turn ${role}${ok ? '' : ' bad'}`;

  const body = document.createElement('div');
  body.className = 'turn-body';

  if (pending) {
    const typing = document.createElement('span');
    typing.className = 'typing';
    typing.setAttribute('aria-label', 'Oscar is thinking');
    for (let i = 0; i < 3; i++) typing.appendChild(document.createElement('i'));
    body.appendChild(typing);
  } else {
    body.textContent = text;
  }

  const detailNode = document.createElement('p');
  detailNode.className = 'turn-detail';
  detailNode.textContent = detail;
  detailNode.hidden = !detail;

  const metaNode = document.createElement('p');
  metaNode.className = 'turn-meta';

  node.append(body, detailNode, metaNode);
  el.thread.appendChild(node);
  el.threadEmpty.hidden = true;
  scrollToEnd(node);

  return { node, body, detailNode, metaNode };
}

/**
 * Fill in a turn that was added as a placeholder.
 *
 * `meta` entries carry a `kind` so the Settings toggles can hide them with CSS
 * alone: an answer already on screen loses its model name the moment you turn
 * the setting off, with nothing re-rendered.
 */
function fillTurn(turn, { text = '', detail = '', ok = true, meta = [] } = {}) {
  if (!turn) return;
  turn.node.classList.toggle('bad', !ok);
  turn.node.classList.remove('working');
  turn.body.replaceChildren(document.createTextNode(text));
  turn.detailNode.textContent = detail || '';
  turn.detailNode.hidden = !detail;

  turn.metaNode.replaceChildren(
    ...meta
      .filter((bit) => bit && bit.text)
      .map((bit) => {
        const tag = document.createElement('span');
        tag.className = `tag${bit.kind ? ` meta-${bit.kind}` : ''}`;
        tag.textContent = bit.text;
        return tag;
      })
  );

  scrollToEnd(turn.node);
}

function scrollToEnd(node) {
  node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Start a fresh thread. The old one is not deleted — it is in History. */
function newConversation() {
  conversationId = null;
  stopWatching();
  el.thread.replaceChildren();
  el.threadEmpty.hidden = false;
  hideConfirm();
  clearLog();
  renderTasks([]);
  setActivity('idle', 'idle');
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

  const dictated = cameFromMic;
  inFlight = true;
  el.send.disabled = true;
  el.send.textContent = 'Thinking…';
  el.question.value = '';

  addTurn('you', { text: question });
  const reply = addTurn('oscar', { pending: true });

  stopWatching();
  clearLog();
  renderTasks([]);
  setActivity('working', 'thinking');
  logLine(question, { kind: 'note' });

  const started = performance.now();

  try {
    const { res, data } = await api('/api/ask', {
      question,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      conversationId: conversationId || undefined,
      dictated: dictated || undefined,
    });

    // The session expired while the page was open.
    if (res.status === 401) {
      showGate();
      showGateError('Your session expired. Sign in again.');
      return;
    }

    const roundTrip = Math.round(performance.now() - started);

    // Every following turn belongs to the same thread as this one.
    if (data.conversationId) conversationId = data.conversationId;

    // A new row exists now, so the history tab should refetch next time it opens.
    historyLoaded = false;

    if (data.async && data.jobId) {
      // Heavy work. The server is already running it; follow along, and leave
      // the reply bubble in place to be filled in when it lands.
      fillTurn(reply, {
        text: data.answer || 'Working on that now.',
        meta: [{ text: `${data.mode} · background job` }],
      });
      reply.node.classList.add('working');

      logLine('handed off to a background job', {
        kind: 'note',
        how: `${data.mode} · routed by ${data.routedBy}`,
      });
      watchJob(data.jobId, data.jobToken, reply);
      loadJobs({ quiet: true }).catch(() => {});
      return;
    }

    fillTurn(reply, {
      ok: Boolean(data.ok),
      text: data.answer || `Server returned ${res.status}.`,
      detail: data.detail,
      meta: data.ok
        ? [
            { text: data.model || 'model', kind: 'model' },
            { text: `${roundTrip}ms`, kind: 'timing' },
            data.rounds > 1 ? { text: `${data.rounds} rounds` } : null,
          ]
        : [{ text: `HTTP ${res.status}` }, { text: `${roundTrip}ms`, kind: 'timing' }],
    });

    // fillTurn clears nothing about a pending confirmation, so this is safe to
    // do after it — but hideConfirm() on every new answer is not, because the
    // answer IS the thing being confirmed.
    if (data.needsConfirmation) showConfirm(data);

    renderTasks(data.tasks || []);
    for (const name of data.tools || []) logLine(name, { how: 'tool' });
    setActivity(data.ok ? 'done' : 'bad', data.ok ? `done · ${data.rounds || 1} rounds` : 'failed');
    if (data.mode) {
      logLine('answered inline', { kind: 'note', how: `${data.mode} · ${data.model || ''}`.trim() });
    }
  } catch (err) {
    fillTurn(reply, {
      ok: false,
      text: String((err && err.message) || err),
      meta: [{ text: 'network error' }],
    });
    setActivity('bad', 'failed');
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
 * Two things are rendered here, and they answer different questions. The TASK
 * LIST says what Oscar decided to do and where he has got to, in his own words;
 * the LOG says which tool ran when. Settings decides whether you see both or
 * just the first — a tool trace is the right thing to look at when something
 * has gone wrong, and noise the rest of the time.
 *
 * Everything is mirrored to console.log too, so the browser devtools give you
 * the same trace without the UI.
 */

let pollTimer = null;
let watchingJob = null;

/**
 * How often to ask a running job how it is getting on.
 *
 * Fast at first, because the first half-minute is when someone is actually
 * watching the panel. A job still going after that is one you have looked away
 * from, and a poll every three seconds is plenty to catch the end of it.
 */
const POLL_FAST_MS = 1200;
const POLL_SLOW_MS = 3000;
const POLL_SLOW_AFTER_MS = 90 * 1000;

/**
 * How long a job may go quiet before this page pokes it.
 *
 * The server advances a job by POSTing to itself, fire and forget, and that hop
 * can be dropped — a function that has already responded may never get its last
 * request out of the door. This page calling /api/step is the second of the two
 * ways a job moves, and the reason a dropped hop costs a pause rather than the
 * whole run.
 *
 * The two numbers are different because the two silences mean different things.
 * 'queued' means no invocation ever picked the job up, which is settled within
 * a second or two of asking. 'running' means one did and then went quiet — and
 * a job that is merely thinking hard goes quiet too, for as long as one round
 * takes. The server touches the row when an invocation starts and again after
 * every round, so the longest honest silence is a single round; this clears
 * that with room to spare, because nudging a job that was working would run it
 * twice over.
 */
const QUEUED_STALL_MS = 10 * 1000;
const RUNNING_STALL_MS = 75 * 1000;

/** Enough to rescue a dropped hop; not so many that a stuck job loops forever. */
const MAX_NUDGES = 5;

/**
 * The pill next to "Oscar's thinking".
 *
 * Two labels, not one. The detailed label is the true one — "running · 12
 * steps" — and the plain one says the same thing without the vocabulary, for
 * when detailed thinking is off. Kept in a variable so flipping the setting
 * re-labels a pill that is already on screen.
 */
const PLAIN_STATUS = { idle: 'idle', working: 'working', done: 'done', bad: 'stopped' };

let lastActivity = { state: 'idle', label: 'idle' };

function setActivity(state, label) {
  lastActivity = { state, label };
  renderActivityStatus();
}

function renderActivityStatus() {
  el.activityStatus.dataset.state = lastActivity.state;
  el.activityStatus.textContent = settings.detailed
    ? lastActivity.label
    : PLAIN_STATUS[lastActivity.state] || lastActivity.label;
}

function clearLog() {
  el.activityLog.replaceChildren();
  updateActivityEmpty();
}

/** The "nothing here yet" line, which depends on what each mode can show. */
function updateActivityEmpty() {
  const hasTasks = !el.taskPanel.hidden;
  const hasLog = el.activityLog.childElementCount > 0 && settings.detailed;
  el.activityEmpty.hidden = hasTasks || hasLog;
  el.activityEmpty.textContent = settings.detailed
    ? 'Ask something. Tool calls and progress appear here as they happen.'
    : 'Ask something. Oscar shows the tasks he is working through here.';
}

/**
 * What Oscar decided to do, and how far through it he is.
 *
 * The list arrives from the server the same way for both kinds of run: an
 * ordinary job builds it by calling plan_tasks, and a mission mirrors its own
 * stored steps into the same shape. This function does not care which.
 */
function renderTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];

  el.taskPanel.hidden = list.length === 0;
  if (!list.length) {
    el.taskList.replaceChildren();
    el.taskProgress.textContent = '';
    updateActivityEmpty();
    return;
  }

  const done = list.filter((task) => task.done).length;
  const current = list.find((task) => !task.done) || null;

  el.taskProgress.textContent = current
    ? `Task ${current.n} of ${list.length} · ${done} done`
    : `All ${list.length} task${list.length === 1 ? '' : 's'} done`;

  el.taskList.replaceChildren(
    ...list.map((task) => {
      const item = document.createElement('li');
      item.className = task.done ? 'done' : current && task.n === current.n ? 'now' : '';

      const mark = document.createElement('span');
      mark.className = 'task-mark';
      mark.setAttribute('aria-hidden', 'true');

      const title = document.createElement('span');
      title.className = 'task-title';
      title.textContent = task.title;

      item.append(mark, title);

      if (task.note) {
        const note = document.createElement('span');
        note.className = 'task-note';
        note.textContent = task.note;
        item.append(note);
      }

      return item;
    })
  );

  updateActivityEmpty();
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
  tick.textContent = new Date()
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .replace(/^(\d)/, '0$1')
    .slice(-8);

  const body = document.createElement('span');
  body.className = 'what';
  body.textContent = what;

  const note = document.createElement('span');
  note.className = 'how';
  note.textContent = how;

  li.append(tick, body, note);
  el.activityLog.appendChild(li);
  updateActivityEmpty();
  if (settings.detailed) el.activityLog.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
 * A poll that finds the job has gone quiet also nudges it along, which is why a
 * lost handoff is recoverable rather than fatal.
 *
 * @param {object} [reply] the turn in the thread this job is answering, if any.
 */
async function watchJob(jobId, token, reply) {
  stopWatching();
  watchingJob = jobId;

  let shown = 0;
  const startedAt = Date.now();

  // Matched to JOB_TTL_MS on the server. Giving up before the job does was the
  // one thing guaranteed to make a slow job look like a broken one.
  const GIVE_UP_AFTER = 15 * 60 * 1000;

  // When the job last visibly moved, and what it looked like then.
  let lastMoved = Date.now();
  let lastMark = '';
  let nudges = 0;

  const tick = async () => {
    if (watchingJob !== jobId) return;

    try {
      const query = new URLSearchParams({ id: jobId });
      if (token) query.set('token', token);
      const { data } = await api(`/api/jobs?${query}`);
      const job = data.job;
      if (!job) throw new Error(data.error || 'Job not found.');

      shown = renderEvents(job.events || [], shown);
      renderTasks(job.tasks || []);

      // Any of these changing means an invocation is alive and checkpointing.
      const mark = [job.status, job.steps, (job.events || []).length, job.updatedAt || ''].join(':');
      if (mark !== lastMark) {
        lastMark = mark;
        lastMoved = Date.now();
      }

      // Answered, but with tasks still open. Deliberately not dressed up as a
      // finish: the list sitting above this is visibly unfinished, and printing
      // "finished" over it is the whole problem.
      if (job.status === 'incomplete') {
        const list = job.tasks || [];
        const ticked = list.filter((task) => task.done).length;

        setActivity('bad', `stopped early · ${job.steps} steps`);
        logLine('stopped early, with tasks still open', {
          kind: 'bad',
          how: `${ticked} of ${list.length} done`,
        });
        fillTurn(reply, {
          text: job.answer || 'I stopped before finishing.',
          detail: job.detail,
          meta: [
            { text: job.model || 'model', kind: 'model' },
            { text: `${ticked} of ${list.length} tasks` },
            { text: 'stopped early' },
          ],
        });
        historyLoaded = false;
        loadJobs({ quiet: true }).catch(() => {});
        return stopWatching();
      }

      if (job.status === 'done') {
        setActivity('done', `done · ${job.steps} steps`);
        logLine('finished', { kind: 'note', how: `${job.steps} steps` });
        fillTurn(reply, {
          text: job.answer || 'Done.',
          detail: job.detail,
          meta: [
            { text: job.model || 'model', kind: 'model' },
            { text: `${job.steps} steps` },
            { text: 'background job' },
          ],
        });
        historyLoaded = false;
        loadJobs({ quiet: true }).catch(() => {});
        return stopWatching();
      }

      if (job.status === 'awaiting_confirm') {
        setActivity('working', 'waiting on you');
        logLine('needs your confirmation', { kind: 'note' });
        fillTurn(reply, { text: job.answer || 'Can I go ahead?' });
        if (job.pendingConfirmation) {
          showConfirm({ confirmToken: null, confirmExpiresInSeconds: 300 });
        }
        return stopWatching();
      }

      if (job.status === 'awaiting_answer') {
        setActivity('working', 'waiting on you');
        logLine('has a question for you', { kind: 'note' });
        fillTurn(reply, { text: job.answer || 'I have a question.' });
        // The question card at the top of the pane is where it gets answered,
        // so bring it up rather than building a second answer box down here.
        loadQuestions().catch(() => {});
        return stopWatching();
      }

      if (job.status === 'failed') {
        setActivity('bad', 'failed');
        logLine(job.error || 'failed', { kind: 'bad' });
        fillTurn(reply, { ok: false, text: job.error || 'The job failed.' });
        historyLoaded = false;
        return stopWatching();
      }

      setActivity('working', `${job.status} · ${job.steps} steps`);

      if (Date.now() - startedAt > GIVE_UP_AFTER) {
        setActivity('bad', 'gave up watching');
        logLine('stopped watching after fifteen minutes — the job may still finish', { kind: 'note' });
        return stopWatching();
      }

      // Quiet for longer than a healthy invocation can be: its baton was
      // dropped somewhere. Pick it up. Not awaited — /api/step does not answer
      // until the step it starts has finished, and the poll above is how we
      // find out what came of it.
      const quietFor = Date.now() - lastMoved;
      const stallLimit = job.status === 'queued' ? QUEUED_STALL_MS : RUNNING_STALL_MS;
      if (quietFor > stallLimit && nudges < MAX_NUDGES) {
        nudges += 1;
        // Treated as movement, so a nudge is not immediately followed by
        // another while the invocation it started gets going.
        lastMoved = Date.now();
        logLine('restarting a job that went quiet', {
          kind: 'note',
          how: `${Math.round(quietFor / 1000)}s without progress`,
        });
        api('/api/step', { jobId, ...(token ? { token } : {}) }).catch(() => {});
      }

      pollTimer = setTimeout(tick, Date.now() - startedAt > POLL_SLOW_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS);
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

  const reply = addTurn('oscar', { pending: true });

  try {
    const { res, data } = await api('/api/confirm', {
      token,
      confirm: agreed,
      // So the outcome is logged into the thread it came from rather than
      // landing in History on its own.
      conversationId: conversationId || undefined,
    });
    hideConfirm();
    fillTurn(reply, {
      ok: Boolean(data.ok),
      text: data.answer || (agreed ? 'Done.' : 'Cancelled.'),
      meta: data.ok ? [] : [{ text: `HTTP ${res.status}` }],
    });
    historyLoaded = false;
  } catch (err) {
    fillTurn(reply, { ok: false, text: String((err && err.message) || err) });
  } finally {
    el.confirmYes.textContent = 'Yes, delete';
  }
}

el.confirmYes.addEventListener('click', () => resolveConfirm(true));
el.confirmNo.addEventListener('click', () => resolveConfirm(false));

/* ================================================================ tabs */

let historyLoaded = false;

const TABS = {
  ask: { tab: el.tabAsk, pane: el.paneAsk },
  jobs: { tab: el.tabJobs, pane: el.paneJobs },
  history: { tab: el.tabHistory, pane: el.paneHistory },
  settings: { tab: el.tabSettings, pane: el.paneSettings },
};

let currentTab = 'ask';

function showTab(which) {
  currentTab = TABS[which] ? which : 'ask';

  for (const [name, { tab, pane }] of Object.entries(TABS)) {
    const on = name === currentTab;
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', String(on));
    pane.hidden = !on;
  }

  if (currentTab === 'history' && !historyLoaded) loadHistory();

  // Polling follows the tab: a job list nobody is looking at does not need to
  // be a second apart, and the badge is refreshed by the ask flow anyway.
  if (currentTab === 'jobs') loadJobs();
  else stopJobsPolling();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

for (const [name, { tab }] of Object.entries(TABS)) {
  tab.addEventListener('click', () => showTab(name));
}

/* --------------------------------------------------------------- formatting */

/** Local time, and a relative hint for anything recent. */
function formatWhen(iso) {
  const when = new Date(iso);
  const mins = Math.round((Date.now() - when.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Meta tags, with the two that Settings can hide marked as such. */
function tagRow(bits) {
  const row = document.createElement('div');
  row.className = 'entry-meta';
  for (const bit of bits) {
    if (!bit || !bit.text) continue;
    const tag = document.createElement('span');
    tag.className = `tag${bit.kind ? ` meta-${bit.kind}` : ''}`;
    tag.textContent = bit.text;
    row.appendChild(tag);
  }
  return row;
}

/* ================================================================= jobs tab */

/** Statuses that mean the job has not finished with you yet. */
const ACTIVE_STATUSES = new Set(['queued', 'running', 'awaiting_confirm', 'awaiting_answer']);

const STATUS_LABEL = {
  queued: 'queued',
  running: 'running',
  awaiting_confirm: 'needs a yes/no',
  awaiting_answer: 'needs an answer',
  done: 'done',
  // Answered, but with tasks left open. Never labelled as a finish — the task
  // list is right there on the card, and calling that "done" is what this
  // status exists to stop.
  incomplete: 'stopped early',
  failed: 'failed',
  cancelled: 'cancelled',
};

let jobsTimer = null;

function stopJobsPolling() {
  clearTimeout(jobsTimer);
  jobsTimer = null;
}

function jobNode(job) {
  const node = document.createElement('article');
  const active = ACTIVE_STATUSES.has(job.status);
  const wrong = job.status === 'failed' || job.status === 'incomplete';
  node.className = `entry job${wrong ? ' bad' : ''}${active ? ' live' : ''}`;

  const head = document.createElement('div');
  head.className = 'job-head';

  const question = document.createElement('div');
  question.className = 'entry-q';
  question.textContent = job.question || '(no question)';

  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.dataset.state = active ? 'working' : job.status === 'done' ? 'done' : 'bad';
  pill.textContent = STATUS_LABEL[job.status] || job.status;

  head.append(question, pill);
  node.append(head);

  if (job.answer || job.error) {
    const answer = document.createElement('div');
    answer.className = 'entry-a';
    answer.textContent = job.error || job.answer;
    node.append(answer);
  }

  // The task list, which is the honest answer to "what is it doing right now".
  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  if (tasks.length) {
    const done = tasks.filter((task) => task.done).length;
    const current = tasks.find((task) => !task.done) || null;

    const progress = document.createElement('p');
    progress.className = 'tasks-head';
    progress.textContent = current
      ? `Task ${current.n} of ${tasks.length} · ${done} done`
      : `All ${tasks.length} task${tasks.length === 1 ? '' : 's'} done`;

    const list = document.createElement('ol');
    list.className = 'tasks-list';
    for (const task of tasks) {
      const item = document.createElement('li');
      item.className = task.done ? 'done' : current && task.n === current.n ? 'now' : '';
      const mark = document.createElement('span');
      mark.className = 'task-mark';
      mark.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'task-title';
      title.textContent = task.title;
      item.append(mark, title);
      list.append(item);
    }

    node.append(progress, list);
  }

  node.append(
    tagRow([
      { text: formatWhen(job.createdAt) },
      job.mode ? { text: job.mode } : null,
      job.steps ? { text: `${job.steps} steps` } : null,
      { text: job.model || '', kind: 'model' },
    ])
  );

  // Offered for every job, not just the ones with a conversation: opening a job
  // is how you get its live task list and event trace into the thinking panel,
  // and that is worth having whether or not there is a thread behind it.
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ghost small';
  open.textContent = active
    ? 'Watch it work'
    : job.conversationId
      ? 'Open conversation'
      : 'Open this job';
  open.addEventListener('click', () => openJob(job));

  node.append(rowOf(open, removeButton(job, node, active)));

  return node;
}

/** A flex row, for the pair of buttons at the foot of a job card. */
function rowOf(...buttons) {
  const row = document.createElement('div');
  row.className = 'row';
  row.append(...buttons);
  return row;
}

/**
 * "Remove", which asks once before it means it.
 *
 * Two taps rather than a dialog: the first turns the button into the question
 * and the second answers it. Removing a job cannot be undone, so one stray tap
 * must never be enough — but a modal for something this small would be worse
 * than the problem it solves. The armed state gives up after five seconds, so a
 * button left half-pressed goes back to being safe on its own.
 *
 * A job still working can be removed too. The server refuses that without an
 * explicit `force`, which this passes only for a card that is actually live —
 * the case worth having, because a run that has gone wrong is exactly the one
 * you want gone.
 */
function removeButton(job, node, active) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost small';
  button.textContent = 'Remove';

  let armed = false;
  let timer = null;

  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    armed = false;
    button.className = 'ghost small';
    button.textContent = 'Remove';
  };

  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.className = 'danger small';
      button.textContent = active ? 'Remove anyway?' : 'Remove for good?';
      timer = setTimeout(disarm, 5000);
      return;
    }

    clearTimeout(timer);
    button.disabled = true;
    button.textContent = 'Removing…';

    try {
      const { res, data } = await api(
        `/api/jobs?id=${encodeURIComponent(job.id)}${active ? '&force=1' : ''}`,
        null,
        'DELETE'
      );

      if (!res.ok) {
        button.disabled = false;
        disarm();
        el.jobsMeta.textContent = (data && data.error) || 'Could not remove that job.';
        return;
      }

      // Stop following a job that no longer exists, or the next poll would
      // report it as lost rather than as gone on purpose.
      if (watchingJob === job.id) stopWatching();

      node.remove();
      loadJobs().catch(() => {});
    } catch (err) {
      button.disabled = false;
      disarm();
      el.jobsMeta.textContent = String((err && err.message) || err);
    }
  });

  return button;
}

/**
 * @param {{quiet?: boolean}} [opts] quiet means "refresh the badge, don't touch
 *        the meta line" — used when the Jobs tab isn't the one on screen.
 */
async function loadJobs(opts = {}) {
  stopJobsPolling();
  if (!opts.quiet) el.jobsMeta.textContent = 'Loading…';

  try {
    const { res, data } = await api('/api/jobs?limit=25');

    if (res.status === 401) {
      if (!opts.quiet) {
        showGate();
        showGateError('Your session expired. Sign in again.');
      }
      return;
    }

    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const active = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));

    el.jobsBadge.textContent = String(active.length);
    el.jobsBadge.hidden = active.length === 0;

    if (opts.quiet) return;

    if (data.configured === false) {
      el.jobsMeta.textContent = '';
      el.jobsList.replaceChildren(emptyLine(
        'No database configured, so there is nowhere to keep a background job. ' +
          'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — see SUPABASE.md.'
      ));
      return;
    }

    if (!data.ok) {
      el.jobsMeta.textContent = data.error || 'Could not load jobs.';
      return;
    }

    el.jobsMeta.textContent = jobs.length
      ? `${active.length} running · ${jobs.length} recent`
      : 'Nothing has needed a background job yet.';

    el.jobsList.replaceChildren(
      ...(jobs.length ? jobs.map(jobNode) : [emptyLine('Ask for something big and it will appear here.')])
    );

    // Only keep polling while something is actually moving.
    if (active.length && currentTab === 'jobs') {
      jobsTimer = setTimeout(() => loadJobs(), 4000);
    }
  } catch (err) {
    if (!opts.quiet) el.jobsMeta.textContent = String((err && err.message) || err);
  }
}

function emptyLine(text) {
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = text;
  return empty;
}

el.jobsRefresh.addEventListener('click', () => loadJobs());

/* ============================================================== history tab */

/**
 * Group rows back into the conversations they happened in.
 *
 * Each stored row is one exchange. Rows that share a conversation id were one
 * back-and-forth and are shown as a single item you can reopen; rows with no id
 * — a Shortcut question, or anything logged before conversations existed — are
 * threads of one, which is exactly what they were.
 *
 * Rows arrive newest-first and stay that way, so `rows[0]` is the latest turn.
 */
function groupThreads(rows) {
  const byKey = new Map();

  for (const row of rows) {
    const key = row.conversation_id || `row:${row.id}`;
    if (!byKey.has(key)) {
      byKey.set(key, { key, conversationId: row.conversation_id || null, rows: [] });
    }
    byKey.get(key).rows.push(row);
  }

  return [...byKey.values()];
}

function threadNode(thread) {
  const latest = thread.rows[0];
  const first = thread.rows[thread.rows.length - 1];
  const turns = thread.rows.length;

  const node = document.createElement('article');
  node.className = `entry${latest.ok ? '' : ' bad'}${thread.conversationId ? ' openable' : ''}`;

  const question = document.createElement('div');
  question.className = 'entry-q';
  question.textContent = first.question || '(empty)';

  const answer = document.createElement('div');
  answer.className = 'entry-a';
  answer.textContent = latest.ok ? latest.answer || '' : latest.error || 'failed';

  node.append(question, answer);

  // Only the middle of a longer thread is worth spelling out — the first
  // question and the last answer are already above.
  if (turns > 1) {
    const more = document.createElement('details');
    const summary = document.createElement('summary');
    summary.className = 'meta';
    summary.textContent = `${turns} turns`;
    more.append(summary);

    for (const row of [...thread.rows].reverse()) {
      const q = document.createElement('div');
      q.className = 'entry-q small-q';
      q.textContent = row.question || '(empty)';
      const a = document.createElement('div');
      a.className = 'entry-a';
      a.textContent = row.ok ? row.answer || '' : row.error || 'failed';
      more.append(q, a);
    }

    node.append(more);
  } else if (latest.detail) {
    const detail = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'more';
    summary.className = 'meta';
    const body = document.createElement('div');
    body.className = 'entry-a';
    body.textContent = latest.detail;
    detail.append(summary, body);
    node.append(detail);
  }

  node.append(
    tagRow([
      { text: formatWhen(latest.created_at) },
      turns > 1 ? { text: `${turns} turns` } : null,
      { text: latest.source || latest.via || '' },
      { text: latest.model || '', kind: 'model' },
      { text: latest.total_ms ? `${latest.total_ms}ms` : '', kind: 'timing' },
      { text: latest.total_tokens ? `${latest.total_tokens} tokens` : '' },
    ])
  );

  if (thread.conversationId) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ghost small';
    open.textContent = 'Continue this conversation';
    open.addEventListener('click', () => openThread(thread.conversationId));
    node.append(open);
  }

  return node;
}

/** The standing invitation, restored whenever the thread is emptied. */
const THREAD_INVITATION = 'Ask Oscar anything. Follow-ups carry on from the answer before them.';

/**
 * Replace the thread with the stored turns of one conversation.
 *
 * The turns are re-fetched rather than reused from whatever card was clicked,
 * because a card only holds what the list query returned — and a thread is read
 * back oldest-first, which is the order it needs to be shown in.
 *
 * @returns {Promise<number>} how many turns were rendered.
 */
async function renderThread(id) {
  el.thread.replaceChildren();
  el.threadEmpty.hidden = false;
  el.threadEmpty.textContent = 'Loading this conversation…';

  try {
    const { data } = await api(`/api/history?conversation=${encodeURIComponent(id)}&limit=50`);
    const rows = (data && data.rows) || [];

    for (const row of rows) {
      addTurn('you', { text: row.question || '' });
      const reply = addTurn('oscar', {});
      fillTurn(reply, {
        ok: Boolean(row.ok),
        text: row.ok ? row.answer || '' : row.error || 'failed',
        detail: row.detail,
        meta: [
          { text: formatWhen(row.created_at) },
          { text: row.model || '', kind: 'model' },
          { text: row.total_ms ? `${row.total_ms}ms` : '', kind: 'timing' },
        ],
      });
    }

    return rows.length;
  } catch (err) {
    el.threadEmpty.textContent = String((err && err.message) || err);
    return 0;
  } finally {
    if (el.thread.childElementCount) el.threadEmpty.hidden = true;
  }
}

/** Reopen a conversation from History and carry on with it. */
async function openThread(id) {
  showTab('ask');
  stopWatching();
  clearLog();
  renderTasks([]);
  setActivity('idle', 'idle');
  hideConfirm();

  conversationId = id;

  const shown = await renderThread(id);
  if (!shown) el.threadEmpty.textContent = THREAD_INVITATION;
  el.question.focus();
}

/**
 * Open a job in the Ask pane, with its progress attached.
 *
 * The conversation alone is not the useful thing here, which is the whole
 * reason this is separate from openThread: a job you are opening from the Jobs
 * tab is usually one you want to WATCH, and its answer does not exist yet. So
 * the task list, the event trace and the live poll come with it.
 *
 * Two cases, and the difference is where the turns come from:
 *
 *   still going — nothing has been logged yet, because a conversation row is
 *                 written when the job finishes. The question is appended here
 *                 with an empty reply underneath, and watchJob fills that reply
 *                 in when the answer lands.
 *   finished    — the answer is already a turn in the thread, so the thread is
 *                 enough. Only jobs with no conversation (an older row, or one
 *                 started before threads existed) get theirs rebuilt from the
 *                 job itself.
 */
async function openJob(job) {
  showTab('ask');
  stopWatching();
  clearLog();
  hideConfirm();

  const active = ACTIVE_STATUSES.has(job.status);

  // Painted from the list row first, so the panel is populated before the
  // fetch below rather than sitting empty while it happens.
  renderTasks(job.tasks || []);
  setActivity(
    active ? 'working' : job.status === 'done' ? 'done' : 'bad',
    active ? `${job.status} · ${job.steps || 0} steps` : STATUS_LABEL[job.status] || job.status
  );

  conversationId = job.conversationId || null;

  if (job.conversationId) {
    await renderThread(job.conversationId);
  } else {
    el.thread.replaceChildren();
    el.threadEmpty.hidden = false;
    el.threadEmpty.textContent = THREAD_INVITATION;
  }

  if (active) {
    addTurn('you', { text: job.question || '' });
    const reply = addTurn('oscar', { pending: true });
    reply.node.classList.add('working');
    // No token: this is a signed-in browser, which /api/jobs accepts on its own.
    watchJob(job.id, null, reply);
    return;
  }

  // Finished. One fetch for the event trace, which the list query does not
  // carry — everything else is already on the row we were handed.
  try {
    const { data } = await api(`/api/jobs?id=${encodeURIComponent(job.id)}`);
    const full = (data && data.job) || job;

    renderTasks(full.tasks || []);
    renderEvents(full.events || [], 0);
    // Three outcomes, and the middle one is the reason this is not a boolean:
    // a job that stopped with tasks open is reopened saying so, exactly as it
    // did while it was being watched.
    const broke = full.status === 'failed';
    const stopped = full.status === 'incomplete';
    logLine(
      broke ? full.error || 'failed' : stopped ? 'stopped early, with tasks still open' : 'finished',
      {
        kind: broke || stopped ? 'bad' : 'note',
        how: `${full.steps || 0} steps`,
      }
    );

    if (!job.conversationId) {
      addTurn('you', { text: full.question || '' });
      const reply = addTurn('oscar', {});
      fillTurn(reply, {
        ok: full.status !== 'failed',
        text: full.status === 'failed' ? full.error || 'The job failed.' : full.answer || '',
        detail: full.detail,
        meta: [
          { text: formatWhen(full.createdAt || job.createdAt) },
          { text: full.model || '', kind: 'model' },
          { text: `${full.steps || 0} steps` },
          ...(stopped ? [{ text: 'stopped early' }] : []),
        ],
      });
    }
  } catch {
    // The list row was enough to show the tasks and the status; a missing event
    // trace is not worth an error message over.
  }
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
      el.historyList.appendChild(
        emptyLine(
          'No database configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel to ' +
            'start logging — see SUPABASE.md.'
        )
      );
      return;
    }

    if (!data.ok) {
      el.historyMeta.textContent = data.error || 'Could not load history.';
      return;
    }

    const rows = data.rows || [];
    const threads = groupThreads(rows);

    el.historyMeta.textContent = rows.length
      ? `${threads.length} conversation${threads.length === 1 ? '' : 's'}, ${rows.length} turn${
          rows.length === 1 ? '' : 's'
        }${term ? ` matching “${term}”` : ''}`
      : '';

    if (!threads.length) {
      el.historyList.appendChild(
        emptyLine(term ? 'Nothing matches that search.' : 'Nothing logged yet. Ask something.')
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const thread of threads) fragment.appendChild(threadNode(thread));
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

/* ------------------------------------------------------------- questions */

/**
 * What Oscar has stopped to ask you.
 *
 * Everything here is built with createElement rather than innerHTML. The text
 * originates from a model and passes through a database, so it is exactly the
 * kind of content that should never be parsed as markup — and the answer box
 * would be an unusually good place to land a script.
 */

let answering = false;

function questionNode(question, onAnswered) {
  const item = document.createElement('li');
  item.className = 'question';

  const text = document.createElement('p');
  text.className = 'question-text';
  text.textContent = question.question;
  item.append(text);

  if (question.context) {
    const why = document.createElement('p');
    why.className = 'meta subtle';
    why.textContent = question.context;
    item.append(why);
  }

  const row = document.createElement('div');
  row.className = 'row question-row';

  const send = async (value) => {
    if (answering || !String(value || '').trim()) return;
    answering = true;
    item.setAttribute('aria-busy', 'true');
    for (const control of item.querySelectorAll('button, input')) control.disabled = true;

    try {
      const { data } = await api('/api/questions', { id: question.id, answer: value });
      if (data.ok) {
        // Say what actually happened. "Answered" when a run picked it back up
        // is different from "answered" when the run had already moved on, and
        // pretending otherwise would be misleading.
        const note = document.createElement('p');
        note.className = 'meta subtle';
        note.textContent = data.alreadyAnswered
          ? data.note || 'That one was already answered.'
          : data.resumed
            ? 'Answered — Oscar is carrying on.'
            : `Answered. ${data.reason ? `The run ${data.reason}.` : ''}`.trim();
        item.replaceChildren(text, note);
        onAnswered();
      } else {
        throw new Error(data.error || 'That did not go through.');
      }
    } catch (err) {
      const oops = document.createElement('p');
      oops.className = 'meta';
      oops.textContent = (err && err.message) || 'That did not go through.';
      item.append(oops);
      for (const control of item.querySelectorAll('button, input')) control.disabled = false;
    } finally {
      answering = false;
      item.removeAttribute('aria-busy');
    }
  };

  if (question.options && question.options.length) {
    // One tap. This is the difference between a question answered on a bus and
    // one still sitting there tomorrow.
    for (const option of question.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost small';
      button.textContent = option;
      button.addEventListener('click', () => send(option));
      row.append(button);
    }
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Your answer…';
    input.autocomplete = 'off';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost small';
    button.textContent = 'Send';

    button.addEventListener('click', () => send(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send(input.value);
    });

    row.append(input, button);
  }

  item.append(row);
  return item;
}

async function loadQuestions() {
  if (!el.questionsCard) return;

  let data;
  try {
    ({ data } = await api('/api/questions'));
  } catch {
    return; // signed out, or unreachable. Leave the card hidden.
  }
  if (!data || !data.ok || !Array.isArray(data.questions) || !data.questions.length) {
    el.questionsCard.hidden = true;
    return;
  }

  const remaining = new Set(data.questions.map((q) => q.id));
  const done = (id) => {
    remaining.delete(id);
    if (!remaining.size) setTimeout(() => loadQuestions(), 1200);
  };

  el.questionsList.replaceChildren(
    ...data.questions.map((q) => questionNode(q, () => done(q.id)))
  );
  el.questionsCard.hidden = false;
}

/* ------------------------------------------------------- notifications */

/**
 * Turning on push, and the one thing that makes it awkward.
 *
 * ON IPHONE THIS ONLY WORKS FROM THE HOME SCREEN. Safari does not expose
 * Notification.requestPermission() to an ordinary tab — the API is simply
 * absent — so the button below cannot work until the site has been added to the
 * Home Screen and opened from there. There is no way to prompt for that and no
 * event announcing it, so the page detects the situation and says so plainly
 * rather than offering a button that fails silently.
 *
 * Everywhere else (desktop Safari, Chrome, Firefox, Android) it just works.
 */

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

/** iOS reports this on `navigator`; everyone else uses the display-mode query. */
const isStandalone =
  window.navigator.standalone === true ||
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

let pushReady = false;

/** A base64url VAPID key as the Uint8Array pushManager.subscribe() demands. */
function decodeKey(base64url) {
  const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function pushSay(text, hint) {
  el.pushStatus.textContent = text;
  el.pushHint.hidden = !hint;
  if (hint) el.pushHint.textContent = hint;
}

async function registerWorker() {
  // `./sw.js` from the site root, so its scope covers the whole app.
  return navigator.serviceWorker.register('./sw.js', { scope: './' });
}

/** Push the current browser's subscription up to the server. */
async function sendSubscription(subscription) {
  const json = subscription.toJSON();
  const { data } = await api('/api/push', {
    action: 'subscribe',
    subscription: { endpoint: json.endpoint, keys: json.keys },
  });
  if (!data.ok) throw new Error(data.error || 'The server would not store that subscription.');
  return data;
}

async function enablePush() {
  el.pushEnable.disabled = true;
  try {
    pushSay('Asking for permission…');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      pushSay(
        permission === 'denied'
          ? 'Notifications are blocked for this site.'
          : 'Permission was dismissed.',
        permission === 'denied'
          ? 'Re-allow them in your browser settings for this site, then reload.'
          : undefined
      );
      return;
    }

    const { data: config } = await api('/api/push');
    if (!config.ok || !config.publicKey) throw new Error(config.error || 'No key from the server.');

    const registration = await registerWorker();
    await navigator.serviceWorker.ready;

    // An existing subscription is reused rather than replaced — the endpoint is
    // stable per browser, so re-subscribing would just re-save the same row.
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        // Required to be true: a push that shows nothing to the user is not
        // allowed on any current browser.
        userVisibleOnly: true,
        applicationServerKey: decodeKey(config.publicKey),
      }));

    await sendSubscription(subscription);

    pushReady = true;
    pushSay('Notifications are on for this device.');
    el.pushEnable.hidden = true;
    el.pushTest.hidden = false;
  } catch (err) {
    pushSay('Could not turn notifications on.', (err && err.message) || String(err));
  } finally {
    el.pushEnable.disabled = false;
  }
}

async function testPush() {
  el.pushTest.disabled = true;
  const previous = el.pushTest.textContent;
  el.pushTest.textContent = 'Sending…';
  try {
    const { data } = await api('/api/push', { action: 'test' });
    pushSay(
      data.ok ? `Sent to ${data.sent} device${data.sent === 1 ? '' : 's'}.` : 'Nothing was sent.',
      data.ok ? undefined : (data.errors && data.errors[0]) || data.error
    );
  } catch (err) {
    pushSay('The test failed.', (err && err.message) || String(err));
  } finally {
    el.pushTest.textContent = previous;
    el.pushTest.disabled = false;
  }
}

async function setupPush() {
  if (!el.pushDetails) return;

  let config;
  try {
    ({ data: config } = await api('/api/push'));
  } catch {
    return; // signed out, or the endpoint isn't there. Stay hidden.
  }
  if (!config || !config.ok || !config.configured) return;

  el.pushDetails.hidden = false;

  // The iPhone case, checked before feature detection so the advice is specific
  // rather than a generic "your browser doesn't support this".
  if (isIOS && !isStandalone) {
    el.pushEnable.hidden = true;
    pushSay(
      'Add Oscar to your Home Screen first.',
      'Share → Add to Home Screen, then open Oscar from there and come back. ' +
        'iPhone only allows notifications for apps added this way.'
    );
    return;
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    el.pushEnable.hidden = true;
    pushSay('This browser cannot do notifications.');
    return;
  }

  // Already granted and already subscribed? Then say so instead of offering a
  // button that would do nothing.
  try {
    const registration = await registerWorker();
    const existing = await registration.pushManager.getSubscription();
    if (Notification.permission === 'granted' && existing) {
      // Re-save on every load. Cheap, and it repairs the case where the server
      // forgot the device (a wiped database) while the browser still has it.
      await sendSubscription(existing).catch(() => {});
      pushReady = true;
      el.pushEnable.hidden = true;
      el.pushTest.hidden = false;
      pushSay('Notifications are on for this device.');
      return;
    }
  } catch {
    /* fall through to the button */
  }

  pushSay(
    config.devices && config.devices.length
      ? `On for ${config.devices.length} other device${config.devices.length === 1 ? '' : 's'}, not this one.`
      : 'Get answers as notifications, even with Oscar closed.'
  );
}

// The worker asks for this when a push service expires a subscription behind
// our back. Re-subscribing needs the public key, which only the page has.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'resubscribe' && pushReady) setupPush();
  });
}

/* ------------------------------------------------------------------- wiring */

el.send.addEventListener('click', ask);
el.newChat.addEventListener('click', () => {
  newConversation();
  el.question.focus();
});

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

el.pushEnable.addEventListener('click', enablePush);
el.pushTest.addEventListener('click', testPush);

setupMic();
init();
