import assert from 'node:assert/strict';
import type {
  AiChatRequest,
  AiChatCompletion,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { createPresentationPlan } from '@bendyline/squisq/transform';
import {
  parsePresentationRefinement,
  refinePresentationPlan,
} from '../src/Presentation/presentation-ai.js';

const plan = () =>
  createPresentationPlan(
    markdownToDoc(
      parseMarkdown(
        '# Your ideas\n\nWrite a few points. Keep your words.\n\n## Share your story\n\nFirst make slides. Then add narration.',
      ),
    ),
  );
function fake(answer: (request: AiChatRequest, index: number) => string) {
  const requests: AiChatRequest[] = [];
  let active = 0,
    maximum = 0,
    cancelled = 0;
  const ai: Pick<DocBlocksHostAiAPI, 'chat'> = {
    chat(request) {
      const index = requests.push(request) - 1;
      maximum = Math.max(maximum, ++active);
      let finish: (value: AiResult<AiChatCompletion>) => void = () => undefined;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) => {
        finish = resolve;
      });
      const timer = setTimeout(() => {
        active--;
        finish({
          ok: true,
          value: { text: answer(request, index), finishReason: 'stop', model: 'test', usage: null },
        });
      }, 5);
      return {
        done,
        cancel() {
          clearTimeout(timer);
          active--;
          cancelled++;
          finish({
            ok: true,
            value: { text: '', finishReason: 'cancelled', model: 'test', usage: null },
          });
        },
      };
    },
  };
  return { ai, requests, maximum: () => maximum, cancelled: () => cancelled };
}
describe('presentation AI refinement', () => {
  it('accepts concise editorial copy but preserves all source anchors', () => {
    const source = plan();
    const reply = JSON.stringify({
      layout: 'list',
      headline: 'Give your ideas a voice',
      points: ['Write a few points.', 'Keep your words.'],
    });
    const beat = parsePresentationRefinement(reply, source, 0)!;
    assert.ok(beat);
    assert.equal(beat.id, source.beats[0]!.id);
    assert.equal(beat.sourceStart, source.beats[0]!.sourceStart);
    assert.equal(beat.sourceEnd, source.beats[0]!.sourceEnd);
    assert.equal(source.origin, 'automatic');
  });
  it('rejects invented facts in points, numbers, asset paths, seconds and offsets', () => {
    const source = plan();
    const base = { layout: 'statement', headline: 'Your ideas', points: ['Keep your words.'] };
    for (const change of [
      { points: ['Save ten hours every week.'] },
      { headline: 'Save 10 hours' },
      { imageSrc: 'https://example.invalid/made-up.png' },
      { seconds: 4 },
      { sourceStart: 12 },
      { layout: 'comparison' },
      { layout: 'image' },
    ])
      assert.equal(
        parsePresentationRefinement(JSON.stringify({ ...base, ...change }), source, 0),
        null,
      );
  });
  it('runs serial bounded requests and retains the baseline after one failed repair', async () => {
    const source = plan();
    const api = fake((request, index) =>
      index < 2
        ? '{}'
        : JSON.stringify({
            ...(JSON.parse(request.messages.at(-1)!.content) as { current: object }).current,
            headline: 'Share your ideas',
          }),
    );
    const result = await refinePresentationPlan(api.ai, source);
    assert.equal(api.maximum(), 1);
    assert.equal(api.requests.length, 3);
    assert.equal(result.retained, 1);
    assert.deepEqual(result.refined, [1]);
    assert.equal(result.plan.origin, 'ai');
    assert.deepEqual(result.plan.beats[0], source.beats[0]);
    assert.equal(result.plan.sourceText, source.sourceText);
    assert.equal(api.requests[0]!.maxTokens, 550);
    assert.ok(api.requests.every((request) => JSON.stringify(request).length < 4000));
  });
  it('cancels the in-flight request and never starts the next beat', async () => {
    const api = fake(() => '{}');
    const controller = new AbortController();
    const pending = refinePresentationPlan(api.ai, plan(), { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(api.requests.length, 1);
    assert.equal(api.cancelled(), 1);
  });
});
