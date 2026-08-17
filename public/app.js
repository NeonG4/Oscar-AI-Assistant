/**
 * public/app.js
 * ----------------------------------------------------------------------------
 * Browser-side test console. It calls the exact same /api/ask endpoint the
 * iOS Shortcut calls, so if it works here it will work on your phone.
 *
 * No framework, no build step — this file is served as-is.
 */

const $ = (id) => document.getElementById(id);

const el = {
  key: $('key'),
  remember: $('remember'),
  question: $('question'),
  mic: $('mic'),
  send: $('send'),
  health: $('health'),
  result: $('result'),
  title: $('r-title'),
  answer: $('r-answer'),
  detail: $('r-detail'),
  meta: $('r-meta'),
  recipe: $('recipe'),
  copy: $('copy'),
  endpoint: $('endpoint'),
};

const ENDPOINT = new URL('/api/ask', location.origin).toString();
const STORE_KEY = 'oscar.key';

/* ------------------------------------------------------------------ storage */
// Wrapped because Safari private mode throws on localStorage access.
const store = {
  get() {
    try {
      return localStorage.getItem(STORE_KEY) || '';
    } catch {
      return '';
    }
  },
  set(v) {
    try {
      if (v) localStorage.setItem(STORE_KEY, v);
      else localStorage.removeItem(STORE_KEY);
      return true;
    } catch {
      return false;
    }
  },
};

/* --------------------------------------------------------------------- init */

function init() {
  el.endpoint.textContent = ENDPOINT;

  const saved = store.get();
  if (saved) {
    el.key.value = saved;
    el.remember.classList.add('on');
  }

  el.recipe.textContent = [
    'Get Contents of URL',
    `  URL     ${ENDPOINT}`,
    '  Method  POST',
    '  Headers x-oscar-key : <your OSCAR_SHARED_SECRET>',
    '  Body    JSON',
    '    question (Text) : Dictated Text',
    '    tz       (Text) : ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  ].join('\n');

  checkHealth();
}

/* ------------------------------------------------------------------- health */

async function checkHealth() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    if (data.config && data.config.openaiKey) {
      el.health.dataset.state = 'ok';
      el.health.textContent = String(data.config.model).replace(' (default)', '');
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

async function ask() {
  const question = el.question.value.trim();
  if (!question || inFlight) return;

  inFlight = true;
  el.send.disabled = true;
  el.send.textContent = 'Thinking…';
  render({ ok: true, title: 'Working…', answer: question, meta: '' });

  const started = performance.now();

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-oscar-key': el.key.value.trim(),
      },
      body: JSON.stringify({
        question,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });

    const data = await res.json().catch(() => ({
      ok: false,
      title: 'Oscar failed',
      answer: `Server returned ${res.status} with an unreadable body.`,
    }));

    const roundTrip = Math.round(performance.now() - started);

    render({
      ok: Boolean(data.ok),
      title: data.title,
      answer: data.answer,
      detail: data.detail,
      meta: data.ok
        ? `${data.model || 'model'} · ${data.elapsedMs ?? '?'}ms model · ${roundTrip}ms round trip`
        : `HTTP ${res.status} · ${roundTrip}ms`,
    });
  } catch (err) {
    render({
      ok: false,
      title: 'Network error',
      answer: String((err && err.message) || err),
      meta: '',
    });
  } finally {
    inFlight = false;
    el.send.disabled = false;
    el.send.textContent = 'Ask Oscar';
  }
}

/* ------------------------------------------------------ dictation (optional) */
// Uses the Web Speech API where it exists (Chrome, Safari). This is only for
// convenience while testing in a browser — on the phone, Shortcuts does the
// dictation natively and never touches this file.

let recognizer = null;

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    el.mic.disabled = true;
    el.mic.title = 'This browser has no speech recognition — type instead';
    return;
  }

  recognizer = new SR();
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
    if (el.question.value.trim()) ask();
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

el.remember.addEventListener('click', () => {
  const on = el.remember.classList.toggle('on');
  const wrote = store.set(on ? el.key.value.trim() : '');
  if (!wrote) {
    el.remember.classList.remove('on');
    el.remember.title = 'This browser blocks local storage';
  }
});

el.key.addEventListener('change', () => {
  if (el.remember.classList.contains('on')) store.set(el.key.value.trim());
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
