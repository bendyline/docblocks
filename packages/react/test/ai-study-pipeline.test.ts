import { expect } from 'chai';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiModelInfo,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { readStudyAidProvenance, studySourceDigest } from '../src/Ai/study-aids.js';
import { generateStudyAid, type StudyStage } from '../src/Ai/study-pipeline.js';
import { studyBudget } from '../src/Ai/study-sections.js';

const DOCUMENT = [
  '# Plants',
  '',
  'Plants take in carbon dioxide and release oxygen during photosynthesis. Photosynthesis ' +
    'happens in the leaves, inside chloroplasts. Roots take up water from the soil, and the ' +
    'study measured growth over 12 weeks.',
  '',
].join('\n');

/** Six sections of about 2,000 characters: more than one part for a 4K model. */
const LONG_DOCUMENT = Array.from(
  { length: 6 },
  (_, section) =>
    `## Section ${String(section + 1)}\n\n` +
    Array.from(
      { length: 30 },
      (__, line) =>
        `Fact ${String(section * 100 + line)} says plants need light, water and carbon dioxide.`,
    ).join(' '),
).join('\n\n');

const NOW = new Date('2026-10-17T18:04:00.000Z');

type Reply =
  | string
  | { readonly text: string; readonly finishReason: 'stop' | 'length' }
  | { readonly error: string }
  | { readonly hang: true };

function model(contextWindow: number): AiModelInfo {
  return { id: 'model-id', label: 'Test Model', local: true, contextWindow, isDefault: true };
}

function completion(text: string, finishReason: AiChatCompletion['finishReason']) {
  return { ok: true as const, value: { text, finishReason, model: 'model-id', usage: null } };
}

/** A chat fake answering from `answer`, recording requests and how many overlapped. */
function scriptedAi(answer: (request: AiChatRequest, index: number) => Reply) {
  const requests: AiChatRequest[] = [];
  const state = { active: 0, maxActive: 0 };
  const api: Pick<DocBlocksHostAiAPI, 'chat'> = {
    chat(request, onEvent) {
      const index = requests.length;
      requests.push(request);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      let settle: (result: AiResult<AiChatCompletion>) => void = () => undefined;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) => {
        settle = resolve;
      }).finally(() => {
        state.active--;
      });
      const reply = answer(request, index);
      if (!(typeof reply === 'object' && 'hang' in reply)) {
        setTimeout(() => {
          onEvent({
            kind: 'progress',
            progress: { phase: 'generating', percent: null, outputTokens: 5, tokensPerSecond: 1 },
          });
          if (typeof reply === 'string') settle(completion(reply, 'stop'));
          else if ('error' in reply) {
            settle({ ok: false, error: { code: 'timeout', message: reply.error } });
          } else settle(completion(reply.text, reply.finishReason));
        }, 0);
      }
      return { done, cancel: () => settle(completion('', 'cancelled')) };
    },
  };
  return { api, requests, state };
}

function systemOf(request: AiChatRequest | undefined): string {
  return request?.messages[0]?.content ?? '';
}

function run(
  ai: Pick<DocBlocksHostAiAPI, 'chat'>,
  options: {
    source?: string;
    contextWindow?: number;
    signal?: AbortSignal;
    stages?: StudyStage[];
  } = {},
) {
  const contextWindow = options.contextWindow ?? 32_768;
  return generateStudyAid({
    ai,
    kind: 'summary',
    source: options.source ?? DOCUMENT,
    sourceName: 'plants.md',
    model: model(contextWindow),
    budget: studyBudget(contextWindow),
    signal: options.signal,
    onStage: (stage) => options.stages?.push(stage),
    now: () => NOW,
  });
}

describe('study aid pipeline', () => {
  it('summarizes a short document in one call and records where it came from', async () => {
    const fake = scriptedAi(() => 'Plants make food from light.\n\n- They take in carbon dioxide.');
    const outcome = await run(fake.api);
    expect(outcome.status).to.equal('ready');
    if (outcome.status !== 'ready') return;
    expect(fake.requests).to.have.length(1);
    expect(fake.requests[0]).to.include({ purpose: 'study', model: 'model-id' });
    expect(systemOf(fake.requests[0])).to.contain('You summarize documents');
    expect(outcome.markdown).to.contain('# Summary: Plants\n\nPlants make food from light.');
    expect(readStudyAidProvenance(outcome.markdown)).to.deep.equal({
      kind: 'summary',
      source: 'plants.md',
      sourceSha256: await studySourceDigest(DOCUMENT),
      generatedAt: NOW.toISOString(),
      model: 'Test Model',
    });
  });

  it('reads a long document part by part, one call at a time, then writes from the notes', async () => {
    const fake = scriptedAi((request) =>
      systemOf(request).includes('You take notes') ? '- A note.' : 'The overview.\n\n- A point.',
    );
    const stages: StudyStage[] = [];
    const outcome = await run(fake.api, {
      source: LONG_DOCUMENT,
      contextWindow: 4_096,
      stages,
    });
    expect(outcome.status).to.equal('ready');
    const notes = fake.requests.filter((request) => systemOf(request).includes('You take notes'));
    expect(notes.length).to.be.greaterThan(1);
    expect(fake.requests).to.have.length(notes.length + 1);
    expect(systemOf(fake.requests.at(-1))).to.contain('You summarize documents');
    expect(fake.requests.at(-1)?.messages[1]?.content).to.contain('<notes>\nPart 1:\n- A note.');
    expect(fake.state.maxActive).to.equal(1);
    expect(stages.map((stage) => stage.kind)).to.deep.equal([
      ...notes.map(() => 'notes'),
      'writing',
    ]);
  });

  it('continues a summary the model cut off, once', async () => {
    const fake = scriptedAi((_request, index) =>
      index === 0 ? { text: 'Plants make food', finishReason: 'length' } : ' from light.',
    );
    const outcome = await run(fake.api);
    expect(fake.requests).to.have.length(2);
    expect(fake.requests[1]?.messages.at(-2)).to.deep.equal({
      role: 'assistant',
      content: 'Plants make food',
    });
    expect(outcome.status === 'ready' && outcome.markdown).to.contain(
      'Plants make food from light.',
    );
  });

  it('fails without saving anything when the host reports an error', async () => {
    const fake = scriptedAi(() => ({ error: 'The model stopped responding.' }));
    expect(await run(fake.api)).to.deep.equal({
      status: 'failed',
      message: 'The model stopped responding.',
    });
  });

  it('stops at once when cancelled, making no further calls', async () => {
    const fake = scriptedAi(() => ({ hang: true }));
    const controller = new AbortController();
    const pending = run(fake.api, {
      source: LONG_DOCUMENT,
      contextWindow: 4_096,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await pending).to.deep.equal({ status: 'cancelled' });
    expect(fake.requests).to.have.length(1);
  });

  it('refuses a document with too little text, without calling the model', async () => {
    const fake = scriptedAi(() => 'unused');
    const outcome = await run(fake.api, { source: '# Title\n\nToo short.\n' });
    expect(outcome.status).to.equal('failed');
    expect(fake.requests).to.have.length(0);
  });
});
