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

import { postWithRetry } from './backoff.js';

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

/**
 * Requests that want a THING built, not an answer written.
 *
 * Deliberately narrow. A mission plans itself and then runs unattended for
 * dozens of model calls, so a false positive is expensive in a way a wrong
 * fast/deep guess never is. It takes both a building verb AND a buildable
 * noun — "write me a story" stays deep, "write me a program" becomes a
 * mission. Anything less clear-cut falls through to the classifier.
 */
const MISSION_MARKERS =
  /\b(build|write|create|make|implement|code|scaffold|set up)\b[^.?!]{0,40}\b(program|script|app|application|game|tool|website|web ?page|cli|bot|library|module|component|endpoint|api|server|dashboard|test suite|prototype)\b/i;

/** @returns {'fast'|'deep'|'mission'|null} null means "not sure, ask the model". */
export function quickClassify(question) {
  const text = String(question || '').trim();
  if (!text) return 'fast';

  // Checked before the deep markers, which also match "write me a …".
  if (MISSION_MARKERS.test(text)) return 'mission';

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
  'fast    — a fact, a lookup, a quick calculation, a short answer. One or two',
  '          tool calls at most. "What is the tallest building in Chicago",',
  '          "what is on my calendar today", "is it going to rain".',
  'deep    — needs several steps, real drafting, or produces something the user',
  '          will keep reading. "Build me a workout plan", "write a story using',
  '          real data", "help me organise my move", "research X and compare".',
  'mission — asks for something to be BUILT and left behind on their computer:',
  '          a program, a script, a tool. Needs files written and commands run,',
  '          not prose produced. "Write me a connect 4 game", "build a script',
  '          that scans my repos", "make me a CLI for my notes".',
  '',
  'The line between deep and mission is what the user ends up with: words to',
  'read is deep, working software is mission. When in doubt choose deep — it is',
  'much cheaper to run.',
  '',
  'Answer with the single word fast, deep or mission. Nothing else.',
].join('\n');

/**
 * @returns {Promise<{mode: 'fast'|'deep'|'mission', via: 'keyword'|'model'|'default'|'forced', model: string}>}
 */
export async function routeQuestion(question, deps = {}) {
  const env = deps.env || process.env;
  const models = routerModels(env);

  const forced = deps.mode;
  if (forced === 'fast' || forced === 'deep' || forced === 'mission') {
    return { mode: forced, via: 'forced', model: forced === 'fast' ? models.fast : models.deep };
  }

  if (!isRoutingEnabled(env)) {
    return { mode: 'fast', via: 'default', model: models.fast };
  }

  const quick = quickClassify(question);
  if (quick) return { mode: quick, via: 'keyword', model: quick === 'fast' ? models.fast : models.deep };

  // Unclear — spend the classifier call.
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return { mode: 'fast', via: 'default', model: models.fast };

  try {
    // Two attempts, not three: the classifier is on the fast path and a
    // question already waiting on it should not wait twice over. Whether the
    // second one happens at all is decided by the budget — if the provider asks
    // for longer than this has left, backoff returns the 429 and the catch
    // below falls through to the fast model, which is the right answer anyway.
    const { res, rawText } = await postWithRetry(
      doFetch,
      'https://api.openai.com/v1/chat/completions',
      {
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
      },
      { budgetMs: CLASSIFY_TIMEOUT_MS, attempts: 2, sleep: deps.sleep, random: deps.random }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = JSON.parse(rawText);
    const word = String(
      (((payload.choices || [])[0] || {}).message || {}).content || ''
    )
      .trim()
      .toLowerCase();

    const mode = word.startsWith('mission') ? 'mission' : word.startsWith('deep') ? 'deep' : 'fast';
    return { mode, via: 'model', model: mode === 'fast' ? models.fast : models.deep };
  } catch (err) {
    // Routing is an optimisation, never a dependency. If the classifier is slow
    // or broken, answer on the fast path rather than failing the request — a
    // slightly weaker answer beats no answer.
    console.error(`[oscar] router fell back to fast: ${(err && err.message) || err}`);
    return { mode: 'fast', via: 'default', model: models.fast };
  }
}
