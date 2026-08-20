/**
 * lib/tools/questions.js
 * ----------------------------------------------------------------------------
 * The tool that lets Oscar stop and ask.
 *
 * Calling this suspends the whole run. The question is saved, you get a
 * notification, and nothing else happens until you answer — at which point the
 * run resumes at the exact point it stopped, with your answer arriving as this
 * tool's result.
 *
 * THE DESCRIPTION BELOW IS THE ACTUAL CONTROL
 *
 * There is no clever gate here, because the failure modes are both about
 * judgement rather than permission. A model that never asks guesses, and a
 * confident wrong guess ten steps into a mission wastes everything built on top
 * of it. A model that asks constantly is just a chat window with extra latency
 * and a notification you have learned to ignore.
 *
 * So the description is written to make asking feel expensive: it names the
 * cost out loud, gives concrete cases for both answers, and insists on a
 * question that can be answered in one tap. Prompt text is doing real
 * engineering work here, which is why it reads the way it does.
 */

import { createQuestion } from '../questions.js';

export const askUserTool = {
  name: 'ask_user',
  description:
    'Stop and ask the user something, then wait for their reply. This SUSPENDS everything you ' +
    'are doing — they may not answer for hours — so it is worth it only when guessing wrong ' +
    'would waste more work than waiting costs. ' +
    'Ask when: the choice is a genuine preference you cannot infer (which language, which of ' +
    'two accounts, what to name a thing); the task is ambiguous in a way that changes what you ' +
    'build; or you are about to do something with consequences you cannot undo. ' +
    'Do NOT ask to check in, to report progress, to confirm something you already have good ' +
    'reason to believe, or for anything you could find out with another tool — look first. ' +
    'One question at a time, answerable in a sentence. Supply `options` whenever the answer is ' +
    'a choice between known alternatives: the user is probably on a phone, and tapping a button ' +
    'is the difference between a fast reply and a forgotten one.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question, in one sentence. Plain language, no preamble.',
      },
      options: {
        type: 'array',
        description: 'Two to six choices, when the answer is a choice. Omit for open questions.',
        items: { type: 'string' },
      },
      context: {
        type: 'string',
        description: 'One line on why you are asking, shown underneath the question.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },

  /**
   * Marks this tool as one that suspends the run.
   *
   * lib/tools/index.js lifts the `question` out of the result, and lib/agent.js
   * stops the round when it sees one. Declared as a flag rather than detected
   * by name so the mechanism stays general.
   */
  asks: true,

  async run(args = {}, ctx = {}) {
    const question = String(args.question || '').trim();
    if (!question) return { error: 'You have to actually ask something.' };

    const saved = await createQuestion(
      {
        question,
        options: args.options,
        context: args.context,
        jobId: ctx.jobId,
      },
      ctx
    );

    // The shape lib/tools/index.js looks for. Everything from here is the
    // caller's problem: the run stops, and resumes when an answer arrives.
    return {
      question: {
        id: saved.id,
        question: saved.question,
        options: saved.options,
        context: saved.context,
      },
    };
  },
};
