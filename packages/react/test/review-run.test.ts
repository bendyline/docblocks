import { expect } from 'chai';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import {
  REVIEW_TOO_LONG_MESSAGE,
  readReviewReply,
  reviewDocument,
  reviewStepRequest,
  startReviewRun,
  type ReviewRun,
} from '../src/Ai/review-run.js';

type Reply = { text: string; finishReason?: 'stop' | 'length' } | { error: string };

/** A chat that answers each request with the next scripted reply, and records the requests. */
function scriptedChat(replies: readonly Reply[]) {
  const requests: AiChatRequest[] = [];
  const chat: DocBlocksHostAiAPI['chat'] = (request) => {
    requests.push(request);
    const reply = replies[requests.length - 1] ?? { text: '[]' };
    const done: Promise<AiResult<AiChatCompletion>> = Promise.resolve(
      'error' in reply
        ? { ok: false, error: { code: 'unknown', message: reply.error } }
        : {
            ok: true,
            value: {
              text: reply.text,
              finishReason: reply.finishReason ?? 'stop',
              model: 'test-model',
              usage: null,
            },
          },
    );
    return { done, cancel: () => undefined };
  };
  return { ai: { chat }, requests };
}

function finding(quote: string, message = 'Make this clearer.'): Record<string, unknown> {
  return {
    quote,
    replacement: `${quote}!`,
    category: 'Clarity',
    severity: 'suggestion',
    message,
    rationale: null,
  };
}

const SOURCE =
  '# Resume\n\nResponsible for managing the team.\n\nHelped with the launch.\n\nWorked on sales.\n';

function run(contextWindow: number | null = 32_768): ReviewRun {
  const start = startReviewRun(SOURCE, 'resume', contextWindow, new Date(2026, 10, 10));
  if (start.kind !== 'run') throw new Error('expected a run');
  return start.run;
}

describe('headless review run', () => {
  it('says when there is nothing to review or too much', () => {
    expect(startReviewRun('  \n', 'general', null).kind).to.equal('empty');
    const tooLong = startReviewRun('word '.repeat(60_000), 'general', null);
    expect(tooLong).to.deep.equal({ kind: 'too-long', message: REVIEW_TOO_LONG_MESSAGE });
  });

  it('states the pinned date in the prompt', () => {
    const request = reviewStepRequest(run(), { part: 0, pass: 0, reported: [] });
    expect(request.messages[0]?.content).to.include('Current local date: 2026-11-10');
  });

  it('collects findings from one reply on a model with room for them', async () => {
    const { ai, requests } = scriptedChat([
      { text: JSON.stringify([finding('Helped with the launch.')]) },
    ]);
    const result = await reviewDocument(ai, run());
    expect(requests).to.have.length(1);
    expect(result.error).to.equal(null);
    expect(result.findings.map((item) => [item.id, item.originalText])).to.deep.equal([
      ['ai-review-1', 'Helped with the launch.'],
    ]);
  });

  it('asks a small model for more while its replies are full, skipping repeats', async () => {
    const six = [
      'Responsible for managing the team.',
      'Helped with the launch.',
      'Worked on sales.',
      'Resume',
      'managing',
      'launch',
    ].map((quote) => finding(quote));
    const { ai, requests } = scriptedChat([
      { text: JSON.stringify(six) },
      // A repeat of an earlier finding and one new one: not full, so the part ends.
      { text: JSON.stringify([finding('Helped with the launch.'), finding('sales')]) },
    ]);
    const result = await reviewDocument(ai, run(4_096));
    expect(requests).to.have.length(2);
    expect(requests[1]?.messages.at(-1)?.content).to.include('Findings were already reported');
    expect(result.findings.map((item) => item.originalText)).to.deep.equal([
      ...six.map((item) => item.quote),
      'sales',
    ]);
    expect(result.findings.at(-1)?.id).to.equal('ai-review-7');
    expect(result.cutOff).to.equal(false);
  });

  it('stops with the reason when the first reply cannot be read', async () => {
    const { ai } = scriptedChat([{ text: 'This is a correct sentence.' }]);
    const result = await reviewDocument(ai, run());
    expect(result.findings).to.deep.equal([]);
    expect(result.partsDone).to.equal(0);
    expect(result.error).to.equal(
      'The AI returned a review DocBlocks could not read. Try reviewing again.',
    );
  });

  it('leaves out a finding with the wrong shape and keeps the rest', async () => {
    const { ai } = scriptedChat([
      { text: JSON.stringify([finding('Worked on sales.'), { quote: 'x', note: 'fine' }]) },
    ]);
    const result = await reviewDocument(ai, run());
    expect(result.error).to.equal(null);
    expect(result.findings.map((item) => item.originalText)).to.deep.equal(['Worked on sales.']);
    expect(result.dropped).to.equal(1);
  });

  it('rejects a reply when every finding has the wrong shape', async () => {
    const { ai } = scriptedChat([{ text: JSON.stringify([{ quote: 'x', note: 'fine' }]) }]);
    const result = await reviewDocument(ai, run());
    expect(result.error).to.match(/could not read/u);
  });

  it('counts findings left out toward a full reply, so it asks for more', async () => {
    const five = Array.from({ length: 5 }, (_, index) => finding(`quote ${String(index)}`));
    const { ai, requests } = scriptedChat([
      { text: JSON.stringify([...five, { quote: 'x', note: 'fine' }]) },
    ]);
    const result = await reviewDocument(ai, run(4_096));
    expect(requests).to.have.length(2);
    expect(result.findings).to.have.length(5);
    expect(result.dropped).to.equal(1);
  });

  it('keeps what a failed follow-up part found and says there may be more', async () => {
    const six = Array.from({ length: 6 }, (_, index) => finding(`quote ${String(index)}`));
    const { ai } = scriptedChat([{ text: JSON.stringify(six) }, { error: 'engine stopped' }]);
    const result = await reviewDocument(ai, run(4_096));
    expect(result.error).to.equal(null);
    expect(result.findings).to.have.length(6);
    expect(result.cutOff).to.equal(true);
  });

  it('reads a cut-off reply as the panel does', () => {
    const current = run();
    const step = { part: 0, pass: 0, reported: [] };
    const partial = `[${JSON.stringify(finding('Worked on sales.'))}, {"quote": "Help`;
    const kept = readReviewReply(current, step, { text: partial, truncated: true });
    expect(kept.kind).to.equal('read');
    if (kept.kind === 'read') {
      expect(kept.fresh.map((item) => item.originalText)).to.deep.equal(['Worked on sales.']);
      expect(kept.followUp?.pass).to.equal(1);
    }
    const none = readReviewReply(current, step, { text: '[{"quote": "Hel', truncated: true });
    expect(none).to.deep.include({ kind: 'unreadable' });
    if (none.kind === 'unreadable') expect(none.message).to.match(/cut off/u);
  });
});
