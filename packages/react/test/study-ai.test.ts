/**
 * DocBlocks lends its AI to Squisq's Study cards view. The protocol — what a
 * model is asked, how replies are judged, the loop — is Squisq's
 * (`@bendyline/squisq/study`) and tested there; this covers what DocBlocks
 * adds: each request carried through the host's chat as the wire allows,
 * one at a time, never searching knowledge; the model's limits; readiness;
 * and stopping.
 */
import { expect } from 'chai';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiModelInfo,
  AiResult,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { parseAiChatRequest } from '@bendyline/docblocks/host';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { studySectionsOf, type GeneratedStudyCard } from '@bendyline/squisq/study';
import { generateStudyCards, studyModelLimits } from '../src/Study/study-ai.js';
import { createStudyAssistant } from '../src/Study/study-assistant.js';

const DOC = [
  '# Plants',
  '',
  'Plants turn light into sugar in their leaves. The leaves hold chlorophyll, which catches the light.',
  '',
  '## Water',
  '',
  'Roots drink water from the soil. A large oak can release 100 litres of water a day.',
].join('\n');
const sections = () => studySectionsOf(markdownToDoc(parseMarkdown(DOC)));

const MODEL: AiModelInfo = {
  id: 'gemma-small',
  label: 'Gemma',
  local: true,
  contextWindow: 8192,
  isDefault: true,
};
const READY: AiStatus = {
  kind: 'ready',
  provider: { name: 'Test provider', version: null, mode: 'hosted' },
  model: MODEL,
  activeRequests: 0,
};

const REPLIES: Record<string, string> = {
  plants:
    '{"cards":[{"question":"Where do plants turn light into sugar?","answer":"In their leaves."}]}',
  water: '{"cards":[{"question":"What do roots drink?","answer":"Water from the soil."}]}',
};

function fakeAi(status: AiStatus = READY) {
  const requests: AiChatRequest[] = [];
  let open = 0;
  let mostOpen = 0;
  let cancelled = 0;
  const listeners = new Set<(status: AiStatus) => void>();
  const ai = {
    status: async () => status,
    onStatus: (listener: (status: AiStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    chat(request: AiChatRequest) {
      requests.push(request);
      open++;
      mostOpen = Math.max(mostOpen, open);
      let finish: (value: AiResult<AiChatCompletion>) => void = () => undefined;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) => {
        finish = resolve;
      });
      const section = /<passage>\n(Plants|Roots)/.exec(request.messages.at(-1)!.content)?.[1];
      const timer = setTimeout(() => {
        open--;
        finish({
          ok: true,
          value: {
            text: REPLIES[section === 'Roots' ? 'water' : 'plants']!,
            finishReason: 'stop',
            model: 'test',
            usage: null,
          },
        });
      }, 3);
      return {
        done,
        cancel() {
          clearTimeout(timer);
          open--;
          cancelled++;
          finish({
            ok: true,
            value: { text: '', finishReason: 'cancelled', model: 'test', usage: null },
          });
        },
      };
    },
  } as unknown as DocBlocksHostAiAPI;
  return {
    ai,
    requests,
    mostOpen: () => mostOpen,
    cancelled: () => cancelled,
    emit: (next: AiStatus) => listeners.forEach((listener) => listener(next)),
  };
}

describe('study card transport', () => {
  it('sends every request as the wire allows: study purpose, its reply shape, no knowledge, one at a time', async () => {
    const fake = fakeAi();
    const result = await generateStudyCards(fake.ai, sections(), {
      kinds: ['flashcard'],
      countFor: () => 1,
      model: MODEL,
    });
    expect(result.cards.map((card) => card.text.question)).to.deep.equal([
      'Where do plants turn light into sugar?',
      'What do roots drink?',
    ]);
    expect(fake.mostOpen()).to.equal(1);
    for (const request of fake.requests) {
      expect(parseAiChatRequest(request), 'passes the wire policy').to.not.equal(null);
      expect(request.purpose).to.equal('study');
      expect(request.searchKnowledge).to.equal(false);
      expect(request.model).to.equal('gemma-small');
      expect(request.responseFormat).to.include({ type: 'json_schema', name: 'study_flashcards' });
      expect(request.maxTokens).to.be.at.most(1024);
      expect(request.messages.map((message) => message.role)).to.deep.equal(['system', 'user']);
    }
  });

  it('sizes requests for the model: small or system models stop replies at 1,024 tokens', () => {
    expect(studyModelLimits(null)).to.deep.equal({ contextTokens: 4096, maxReplyTokens: 1024 });
    expect(studyModelLimits({ contextWindow: 131072, system: true })).to.deep.equal({
      contextTokens: 131072,
      maxReplyTokens: 1024,
    });
    expect(studyModelLimits({ contextWindow: 131072 })).to.deep.equal({
      contextTokens: 131072,
      maxReplyTokens: null,
    });
  });
});

describe('the study assistant', () => {
  it('is ready only with a ready model, and follows the host', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'opt-out' });
    const assistant = createStudyAssistant(fake.ai);
    expect(await assistant.readiness()).to.be.a('string');
    let heard = 0;
    const stop = assistant.onReadinessChange!(() => heard++);
    fake.emit(READY);
    stop();
    fake.emit(READY);
    expect(heard).to.equal(1);
    expect(await createStudyAssistant(fakeAi().ai).readiness()).to.equal(null);
  });

  it('hands each card over as it is made, and stops when asked', async () => {
    const fake = fakeAi();
    const assistant = createStudyAssistant(fake.ai);
    const controller = new AbortController();
    const cards: GeneratedStudyCard[] = [];
    const run = assistant.generateCards(
      { sections: sections(), kinds: ['flashcard'] },
      {
        signal: controller.signal,
        onProgress: () => undefined,
        onCard: (card) => {
          cards.push(card);
          controller.abort();
        },
      },
    );
    let error: unknown;
    await run.catch((cause: unknown) => (error = cause));
    expect((error as Error).name).to.equal('AbortError');
    expect(cards).to.have.length(1);
    expect(cards[0]!.text).to.include({ origin: 'ai' });
  });

  it('says why it cannot run, in a plain sentence', async () => {
    const assistant = createStudyAssistant(
      fakeAi({ kind: 'unavailable', reason: 'not-running' }).ai,
    );
    let error: unknown;
    await assistant
      .generateCards(
        { sections: sections(), kinds: ['flashcard'] },
        {
          signal: new AbortController().signal,
          onProgress: () => undefined,
          onCard: () => undefined,
        },
      )
      .catch((cause: unknown) => (error = cause));
    expect((error as Error).message).to.equal(await assistant.readiness());
  });
});
