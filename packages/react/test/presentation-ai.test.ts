/**
 * DocBlocks' transport for Squisq's deck wording. The loop (storyboard, one
 * request per slide, one corrected retry) and the reading of each reply are
 * Squisq's `wordPresentationPlan` and are tested there; this covers only how
 * DocBlocks carries each request through the host's chat and its outcome back.
 */
import assert from 'node:assert/strict';
import type {
  AiChatRequest,
  AiChatCompletion,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import {
  PRESENTATION_AUTHOR_LIMITS,
  createPresentationPlan,
  presentationSlidePrompt,
} from '@bendyline/squisq/transform';
import { refinePresentationPlan } from '../src/Presentation/presentation-ai.js';

const plan = () =>
  createPresentationPlan(
    markdownToDoc(
      parseMarkdown(
        '# Your ideas\n\nWrite a few points. Keep your words.\n\n## Share your story\n\nFirst make slides. Then add narration.',
      ),
    ),
  );

/** The slide a request shows the model, changed as the test asks. */
const echo =
  (change: Record<string, unknown> = {}) =>
  (request: AiChatRequest) =>
    JSON.stringify({
      ...(JSON.parse(request.messages.at(-1)!.content) as { current: object }).current,
      ...change,
    });

function fake(
  answer: (request: AiChatRequest, index: number) => AiResult<AiChatCompletion> | string,
) {
  const requests: AiChatRequest[] = [];
  let cancelled = 0;
  const ai: Pick<DocBlocksHostAiAPI, 'chat'> = {
    chat(request) {
      const index = requests.push(request) - 1;
      let finish: (value: AiResult<AiChatCompletion>) => void = () => undefined;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) => {
        finish = resolve;
      });
      const timer = setTimeout(() => {
        const reply = answer(request, index);
        finish(
          typeof reply === 'string'
            ? {
                ok: true,
                value: { text: reply, finishReason: 'stop', model: 'test', usage: null },
              }
            : reply,
        );
      }, 5);
      return {
        done,
        cancel() {
          clearTimeout(timer);
          cancelled++;
          finish({
            ok: true,
            value: { text: '', finishReason: 'cancelled', model: 'test', usage: null },
          });
        },
      };
    },
  };
  return { ai, requests, cancelled: () => cancelled };
}

describe('presentation AI transport', () => {
  it('sends each request through the host chat, pinned to its reply shape', async () => {
    const api = fake(echo({ headline: 'Share your ideas' }));
    const result = await refinePresentationPlan(api.ai, plan());
    assert.ok(result.refined.length > 0);
    const [request] = api.requests;
    // A reasoning model would spend the small cap thinking; only `write` may reason.
    assert.equal(request!.purpose, 'illustrate');
    assert.equal(request!.maxTokens, PRESENTATION_AUTHOR_LIMITS.slideTokens);
    assert.equal(request!.temperature, PRESENTATION_AUTHOR_LIMITS.temperature);
    assert.deepEqual(
      request!.messages.map((message) => message.role),
      ['system', 'user'],
    );
    assert.equal(request!.messages[0]!.content, presentationSlidePrompt());
    // Structured output limits the reply to the fields the reader accepts.
    const format = request!.responseFormat!;
    assert.equal(format.type, 'json_schema');
    assert.equal((format as { name?: string }).name, 'presentation_slide');
    assert.deepEqual((format.schema as { required: string[] }).required, [
      'layout',
      'headline',
      'points',
    ]);
  });

  it('reports a reply cut off at the token limit, so the slide is asked again', async () => {
    const api = fake((request, index) =>
      index === 0
        ? {
            ok: true,
            value: { text: '{"layout": "sta', finishReason: 'length', model: 'test', usage: null },
          }
        : echo()(request),
    );
    await refinePresentationPlan(api.ai, plan());
    const retry = JSON.parse(api.requests[1]!.messages.at(-1)!.content) as { correction?: string };
    assert.match(retry.correction ?? '', /cut off/u);
  });

  it('ends the run with the host’s error', async () => {
    const api = fake(() => ({
      ok: false,
      error: { code: 'unknown', message: 'The model stopped responding.' },
    }));
    await assert.rejects(refinePresentationPlan(api.ai, plan()), {
      message: 'The model stopped responding.',
    });
  });

  it('cancels the in-flight request and never starts the next beat', async () => {
    const api = fake(() => '{}');
    const controller = new AbortController();
    let reported = 0;
    const pending = refinePresentationPlan(api.ai, plan(), {
      signal: controller.signal,
      onBeat: () => reported++,
    });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(api.requests.length, 1);
    assert.equal(api.cancelled(), 1);
    assert.equal(reported, 0);
  });
});
