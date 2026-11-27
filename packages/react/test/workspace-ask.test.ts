import { expect } from 'chai';
import type {
  AiChatEvent,
  AiChatKnowledge,
  AiChatRequest,
  AiFactCheckRequest,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import {
  answerBlocks,
  askRequest,
  createWorkspaceAskSession,
  type AskChat,
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

const used: AiChatKnowledge = {
  outcome: 'used',
  sources: [{ catalogId: 'workspace', name: 'This workspace', titles: [passage.title] }],
  evidence: [
    { title: passage.title, catalogId: 'workspace', text: passage.text, uri: passage.uri },
  ],
};

/** A host AI that answers each request with `reply`, emitting its knowledge first. */
function fakeAi(reply = 'Aphids arrive in **May** [1].', knowledge: AiChatKnowledge = used) {
  const requests: AiChatRequest[] = [];
  const checks: AiFactCheckRequest[] = [];
  let release: () => void = () => undefined;
  let hold = false;
  const ai = {
    chat(request: AiChatRequest, onEvent: (event: AiChatEvent) => void) {
      requests.push(request);
      let cancelled = false;
      const done = (async () => {
        onEvent({ kind: 'knowledge', knowledge });
        if (cancelled)
          return { ok: false as const, error: { code: 'cancelled' as const, message: 'x' } };
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

describe('Ask', () => {
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

  it('chats with the model when no note matches, and checks nothing it did not source', async () => {
    const { ai, requests, checks } = fakeAi('Hello! How can I help?', { outcome: 'none' });
    const session = createWorkspaceAskSession();
    session.configure({ ai, findPassages: async () => [] });
    await session.ask('hi');
    expect(requests).to.have.length(1);
    expect(requests[0]).to.not.have.property('workspacePassages');
    expect(session.getSnapshot().turns.map((entry) => [entry.status, entry.answer])).to.deep.equal([
      ['done', 'Hello! How can I help?'],
    ]);
    expect(checks).to.have.length(0);
    session.clear();
    expect(session.getSnapshot().turns).to.deep.equal([]);
  });

  it('keeps the newest turns within the history budget', () => {
    const long = 'x'.repeat(1_400);
    const history = Array.from({ length: 10 }, (_, index) =>
      turn({ id: index + 1, question: `Q${index + 1}`, answer: long }),
    );
    const request = askRequest(history, 'Next?', []);
    const asked = request.messages.filter((message) => message.role === 'user');
    // Eight turns at most, and only as many as fit 8,000 characters: the newest five.
    expect(asked.map((message) => message.content)).to.deep.equal([
      'Q6',
      'Q7',
      'Q8',
      'Q9',
      'Q10',
      'Next?',
    ]);
  });

  it('answers from the task list when no note matches, telling the model the facts are exact', async () => {
    const { ai, requests } = fakeAi('Call Priya is due tomorrow.', { outcome: 'none' });
    const session = createWorkspaceAskSession();
    const facts =
      'Today is Monday 23 November 2026 (2026-11-23).\nDue in the next 14 days:\n- Call Priya (due tomorrow)';
    session.configure({ ai, findPassages: async () => [], facts: () => facts });
    await session.ask('What is due this week?');
    expect(requests).to.have.length(1);
    const system = requests[0]!.messages.filter((message) => message.role === 'system');
    expect(system[1]?.content)
      .to.include('They are exact')
      .and.include('- Call Priya (due tomorrow)');
    expect(requests[0]).to.not.have.property('workspacePassages');
    expect(session.getSnapshot().turns.map((entry) => [entry.status, entry.answer])).to.deep.equal([
      ['done', 'Call Priya is due tomorrow.'],
    ]);
  });

  it('answers anyway when Gezel finds none of the passages answers the question', async () => {
    const { ai, requests, checks } = fakeAi('Ladybirds do.', { outcome: 'none' });
    const session = createWorkspaceAskSession();
    session.configure({ ai, findPassages: async () => [passage] });
    await session.ask('What eats them?');
    expect(requests).to.have.length(1);
    expect(session.getSnapshot().turns.map((entry) => [entry.status, entry.answer])).to.deep.equal([
      ['done', 'Ladybirds do.'],
    ]);
    expect(session.getSnapshot().generation).to.equal(null);
    expect(checks).to.have.length(0);
  });

  it('saves each settled turn in order, into the chat the first one made', async () => {
    const { ai } = fakeAi();
    const session = createWorkspaceAskSession();
    const saves: Array<[string, AskChat | null]> = [];
    let release: () => void = () => undefined;
    const firstSave = new Promise<void>((resolve) => (release = resolve));
    session.configure({
      ai,
      findPassages: async () => [passage],
      save: async (settled, chat) => {
        saves.push([settled.question, chat]);
        if (saves.length === 1) await firstSave;
        return { workspaceId: 'w', path: 'Chats/First.md' };
      },
    });
    await session.ask('First?');
    // The second answer settles while the first is still being written.
    await session.ask('Second?');
    expect(saves).to.have.length(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saves).to.deep.equal([
      ['First?', null],
      ['Second?', { workspaceId: 'w', path: 'Chats/First.md' }],
    ]);
    expect(session.getSnapshot().chat).to.deep.equal({ workspaceId: 'w', path: 'Chats/First.md' });
    session.moveChat('Chats/First.md', 'Chats/Renamed.md');
    expect(session.getSnapshot().chat?.path).to.equal('Chats/Renamed.md');
    session.moveChat('Chats/Renamed.md', null);
    expect(session.getSnapshot().chat).to.equal(null);
  });

  it('shows a saved chat, continues it, and saves nothing for one cleared meanwhile', async () => {
    const { ai, requests } = fakeAi();
    const session = createWorkspaceAskSession();
    const saved: Array<AskChat | null> = [];
    session.configure({
      ai,
      findPassages: async () => [passage],
      save: async (_turn, chat) => {
        saved.push(chat);
        return chat;
      },
    });
    const chat = { workspaceId: 'w', path: 'Chats/Aphids.md' };
    session.restore([turn({ question: 'When?', answer: 'In May [1].', knowledge: used })], chat);
    expect(session.getSnapshot().chat).to.deep.equal(chat);
    await session.ask('What eats them?');
    // The restored turn is history for the model.
    expect(requests[0]?.messages.map((message) => message.content)).to.include('When?');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).to.deep.equal([chat]);
    expect(session.getSnapshot().turns.map((entry) => entry.question)).to.deep.equal([
      'When?',
      'What eats them?',
    ]);
    session.clear();
    expect(session.getSnapshot().chat).to.equal(null);
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
