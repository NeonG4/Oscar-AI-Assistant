/**
 * lib/router.js
 * ----------------------------------------------------------------------------
 * Decides how much machinery a question deserves.
 *
 *   "what's the largest building in Chicago"  → fast model, answered inline
 *   "build me a workout plan"                 → strong model, run as a job
 *
 * WHY A SEPARATE CLASSIFIER RATHER THAN LETTING THE MODEL DECIDE
 *
 * The tempting alternative is to give the fast model an `escalate` tool and let
 * it call that when out of its depth. Zero added latency — but it relies on a
 * small model recognising its own limits, which it is not reliable at. A tiny
 * explicit classifier is predictable, and predictability is worth the ~300ms.
 *
 * THAT LATENCY IS PAID ON THE FAST PATH, which is the one being optimised for
 * speed. Two things keep it small: the prompt is a few dozen tokens, and the
 * reply is capped at one word. There is also a keyword short-circuit below for
 * questions that are obviously one kind or the other, which skips the call
 * entirely — most real traffic never reaches the model.
 */

const CLASSIFY_TIMEOUT_MS = 6000;

export function routerModels(env = process.env) {
  return {
    fast: env.OSCAR_FAST_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini',
    deep: env.OSCAR_DEEP_MODEL || 'gpt-4o',
    router: env.OSCAR_ROUTER_MODEL || env.OSCAR_FAST_MODEL || 'gpt-4o-mini',
  };
}

export function isRoutingEnabled(env = process.env) {
  return env.OSCAR_DISABLE_ROUTING !== '1';
}

/**
 * Cheap structural signals, checked before spending a model call.
 *
 * Deliberately conservative in one direction: these only fire on strong
 * evidence, and anything unclear falls through to the classifier. Guessing
 * "fast" for a hard question gives a poor answer; guessing "deep" for an easy
 * one costs seconds. Neither is worth a sloppy heuristic.
 */
const DEEP_MARKERS =
  /\b(plan|organi[sz]e|schedule out|strategy|roadmap|itinerary|curriculum|workout|routine|budget|research|compare .* and .* and|write me (a|an) (story|essay|article|report|letter)|draft (a|an)|step by step|walk me through|help me (build|set up|prepare|figure out))\b/i;

const FAST_MARKERS =
  /^(what|who|when|where|which|how (much|many|old|far|long|tall))\b|^(is|are|was|were|did|does|do|can|should)\b/i;

/** @returns {'fast'|'deep'|null} null means "not sure, ask the model". */
export function quickClassify(question) {
  const text = String(question || '').trim();
  if (!text) return 'fast';

  // Long questions are almost never one-liners.
  if (text.length > 280) return 'deep';
  if (DEEP_MARKERS.test(text)) return 'deep';

  // A short interrogative with no deep marker is a lookup.
  if (text.length < 90 && FAST_MARKERS.test(text)) return 'fast';

  return null;
}

const SYSTEM = [
  'Classify how much work a request needs. Reply with exactly one word.',
  '',
  'fast  — a fact, a lookup, a quick calculation, a short answer. One or two',
  '        tool calls at most. "What is the tallest building in Chicago",',
  '        "what is on my calendar today", "is it going to rain".',
  'deep  — needs several steps, real drafting, or produces something the user',
  '        will keep. "Build me a workout plan", "write a story using real data",',
  '        "help me organise my move", "research X and compare the options".',
  '',
  'Answer with the single word fast or deep. Nothing else.',
].join('\n');

/**
 * @returns {Promise<{mode: 'fast'|'deep', via: 'keyword'|'model'|'default'|'forced', model: string}>}
 */
export async function routeQuestion(question, deps = {}) {
  const env = deps.env || process.env;
  const models = routerModels(env);

  const forced = deps.mode;
  if (forced === 'fast' || forced === 'deep') {
    return { mode: forced, via: 'forced', model: forced === 'deep' ? models.deep : models.fast };
  }

  if (!isRoutingEnabled(env)) {
    return { mode: 'fast', via: 'default', model: models.fast };
  }

  const quick = quickClassify(question);
  if (quick) return { mode: quick, via: 'keyword', model: quick === 'deep' ? models.deep : models.fast };

  // Unclear — spend the classifier call.
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return { mode: 'fast', via: 'default', model: models.fast };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);

  try {
    const res = await doFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: models.router,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: String(question).slice(0, 500) },
        ],
        temperature: 0,
        max_tokens: 3,
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = JSON.parse(await res.text());
    const word = String(
      (((payload.choices || [])[0] || {}).message || {}).content || ''
    )
      .trim()
      .toLowerCase();

    const mode = word.startsWith('deep') ? 'deep' : 'fast';
    return { mode, via: 'model', model: mode === 'deep' ? models.deep : models.fast };
  } catch (err) {
    // Routing is an optimisation, never a dependency. If the classifier is slow
    // or broken, answer on the fast path rather than failing the request — a
    // slightly weaker answer beats no answer.
    console.error(`[oscar] router fell back to fast: ${(err && err.message) || err}`);
    return { mode: 'fast', via: 'default', model: models.fast };
  } finally {
    clearTimeout(timer);
  }
}
