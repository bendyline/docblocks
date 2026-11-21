import { expect } from 'chai';
import type {
  AiChatEvent,
  AiChatRequest,
  AiFactCheckRequest,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import {
  answerBlocks,
  askRequest,
  createWorkspaceAskSession,
  type AskTurn,
} from '../src/Ai/workspace-ask.js';

const passage = {
  uri: 'knowledge://local/ws-1/garden/roses.md#line=3-9',
  title: 'Rose bed › Pests',
  text: 'Aphids cluster on new growth in May.',
};

const turn = (overrides: Partial<AskTurn>): AskTurn => ({
  id: 1,
  question: 'When do aphids come?',
  answer: 'In May [1].',
  status: 'done',
  knowledge: null,
  facts: null,
  error: null,
  truncated: false,
  ...overrides,
});

/** A host AI that answers each request with `reply`, emitting its knowledge first. */
function fakeAi(reply = 'Aphids arrive in **May** [1].') {
  const requests: AiChatRequest[] = [];
  const checks: AiFactCheckRequest[] = [];
  let release: () => void = () => undefined;
  let hold = false;
  const ai = {
    chat(request: AiChatRequest, onEvent: (event: AiChatEvent) => void) {
      requests.push(request);
      let cancelled = false;
      const done = (async () => {
        onEvent({
          kind: 'knowledge',
          knowledge: {
            outcome: 'used',
            sources: [{ catalogId: 'ws-1', name: 'This workspace', titles: [passage.title] }],
            evidence: [
              { title: passage.title, catalogId: 'ws-1', text: passage.text, uri: passage.uri },
            ],
          },
        });
        if (hold) await new Promise<void>((resolve) => (release = resolve));
        if (cancelled)
          return { ok: false as const, error: { code: 'cancelled' as const, message: 'x' } };
        onEvent({ kind: 'delta', text: reply });
        return {
          ok: true as const,
          value: { text: reply, model: 'm', finishReason: 'stop' as const, usage: null },
        };
      })();
      return {
        done,
        cancel: () => {
          cancelled = true;
          release();
        },
      };
    },
    async checkFacts(request: AiFactCheckRequest) {
      checks.push(request);
      return { ok: true as const, value: { checked: 1, unsourced: [] } };
    },
  } as unknown as Pick<DocBlocksHostAiAPI, 'chat' | 'checkFacts'>;
  return {
    ai,
    requests,
    checks,
    holdNext: () => {
      hold = true;
    },
  };
}

describe('Ask your workspace', () => {
  it('asks with the passages and the last finished turns, citations stripped', () => {
    const history = [
      turn({ id: 1, question: 'Old', answer: 'Older answer [2].' }),
      turn({ id: 2, question: 'Stopped', status: 'stopped' }),
      turn({ id: 3, question: 'When do aphids come?', answer: 'In May [1].' }),
    ];
    const request = askRequest(history, 'What eats them?', [passage]);
    expect(request).to.deep.include({
      purpose: 'chat',
      knowledgeQuery: 'What eats them?',
      knowledgeCitations: true,
      workspacePassages: [passage],
    });
    expect(request.messages.map((message) => [message.role, message.content])).to.deep.equal([
      ['system', request.messages[0]?.content],
      ['user', 'Old'],
      ['assistant', 'Older answer.'],
      ['user', 'When do aphids come?'],
      ['assistant', 'In May.'],
      ['user', 'What eats them?'],
    ]);
  });

  it('reads an answer as paragraphs, lists and headings with citations inline', () => {
    expect(
      answerBlocks(
        '## Pests\nAphids come in **May** [1, 2].\n\n- Ladybirds eat them [3]\n- Soap `spray`',
      ),
    ).to.deep.equal([
      { kind: 'heading', inlines: [{ kind: 'text', text: 'Pests' }] },
      {
        kind: 'paragraph',
        inlines: [
          { kind: 'text', text: 'Aphids come in ' },
          { kind: 'strong', text: 'May' },
          { kind: 'cite', numbers: [1, 2] },
          { kind: 'text', text: '.' },
        ],
      },
      {
        kind: 'list',
        ordered: false,
        items: [
          [
            { kind: 'text', text: 'Ladybirds eat them' },
            { kind: 'cite', numbers: [3] },
          ],
          [
            { kind: 'text', text: 'Soap ' },
            { kind: 'code', text: 'spray' },
          ],
        ],
      },
    ]);
    // Markup a model writes stays text.
    expect(answerBlocks('<b>x</b>')).to.deep.equal([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: '<b>x</b>' }] },
    ]);
  });

  it('answers from the passages it finds and checks the details', async () => {
    const { ai, requests, checks } = fakeAi();
    const session = createWorkspaceAskSession();
    session.configure({ ai, findPassages: async () => [passage] });
    let notified = 0;
    session.subscribe(() => (notified += 1));
    await session.ask('  When do aphids come?  ');
    const [answered] = session.getSnapshot().turns;
    expect(answered).to.deep.include({
      question: 'When do aphids come?',
      answer: 'Aphids arrive in **May** [1].',
      status: 'done',
      facts: { checked: 1, unsourced: [] },
    });
    expect(answered?.knowledge?.outcome).to.equal('used');
    expect(requests[0]?.workspacePassages).to.deep.equal([passage]);
    expect(checks[0]).to.deep.include({ citations: true, evidence: [passage.text] });
    expect(session.getSnapshot().generation).to.equal(null);
    expect(notified).to.be.greaterThan(2);
  });

  it('never asks the model when no note matches', async () => {
    const { ai, requests } = fakeAi();
    const session = createWorkspaceAskSession();
    session.configure({ ai, findPassages: async () => [] });
    await session.ask('Anything about tides?');
    expect(session.getSnapshot().turns.map((entry) => entry.status)).to.deep.equal(['nothing']);
    expect(requests).to.have.length(0);
    session.clear();
    expect(session.getSnapshot().turns).to.deep.equal([]);
  });

  it('stops a running answer and takes one question at a time', async () => {
    const { ai, requests, holdNext } = fakeAi();
    holdNext();
    const session = createWorkspaceAskSession();
    session.configure({ ai, findPassages: async () => [passage] });
    const asking = session.ask('First?');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.ask('Second?');
    expect(session.getSnapshot().turns.map((entry) => entry.question)).to.deep.equal(['First?']);
    session.stop();
    await asking;
    expect(session.getSnapshot().turns.map((entry) => entry.status)).to.deep.equal(['stopped']);
    expect(session.getSnapshot().generation).to.equal(null);
    expect(requests).to.have.length(1);
  });
});
