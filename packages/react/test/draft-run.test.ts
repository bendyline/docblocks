import { expect } from 'chai';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { buildDraftRequest } from '../src/Ai/ai-assistant.js';
import { runDraft, settleDraft } from '../src/Ai/draft-run.js';

type Reply = { text: string; finishReason?: 'stop' | 'length' } | { error: string };

function scriptedChat(replies: readonly Reply[]) {
  const requests: AiChatRequest[] = [];
  const chat: DocBlocksHostAiAPI['chat'] = (request) => {
    requests.push(request);
    const reply = replies[requests.length - 1] ?? { text: '' };
    const done: Promise<AiResult<AiChatCompletion>> = Promise.resolve(
      'error' in reply
        ? { ok: false, error: { code: 'unknown', message: reply.error } }
        : {
            ok: true,
            value: {
              text: reply.text,
              finishReason: reply.finishReason ?? 'stop',
              model: 'm',
              usage: null,
            },
          },
    );
    return { done, cancel: () => undefined };
  };
  return { ai: { chat }, requests };
}

const DOCUMENT = '# Garden notes\n\nThe garden opens at 9.\n';
const request = buildDraftRequest({
  mode: 'compose',
  instructions: 'Add a closing paragraph.',
  documentSource: DOCUMENT,
  selectedText: '',
});

describe('headless draft', () => {
  it('cleans up a reply that finished in one go, as Insert would', async () => {
    const { ai } = scriptedChat([{ text: '```markdown\nSee you there.\n```' }]);
    const result = await runDraft(ai, request, DOCUMENT, 'compose');
    expect(result).to.deep.equal({
      text: 'See you there.',
      finished: true,
      continuations: 0,
      requests: 1,
      error: null,
    });
  });

  it('continues a draft cut off at the limit, keeping the join, as Continue does', async () => {
    const { ai, requests } = scriptedChat([
      { text: 'The garden is a shared ', finishReason: 'length' },
      { text: 'space for everyone.' },
    ]);
    const result = await runDraft(ai, request, DOCUMENT, 'compose');
    expect(result.text).to.equal('The garden is a shared space for everyone.');
    expect(result.finished).to.equal(true);
    expect(result.continuations).to.equal(1);
    expect(requests[1]?.messages.at(-1)?.content).to.match(/stopped before finishing/u);
  });

  it('stops after its continuations, and on an empty continuation', async () => {
    const cut = { text: 'Part ', finishReason: 'length' as const };
    const limited = await runDraft(scriptedChat([cut, cut, cut]).ai, request, DOCUMENT, 'compose');
    expect(limited.finished).to.equal(false);
    expect(limited.requests).to.equal(2);
    const empty = await runDraft(
      scriptedChat([cut, { text: '  ' }]).ai,
      request,
      DOCUMENT,
      'compose',
      {
        maxContinuations: 3,
      },
    );
    expect(empty.finished).to.equal(false);
    expect(empty.requests).to.equal(2);
  });

  it('reports a failure with what was drafted so far', async () => {
    const result = await runDraft(
      scriptedChat([{ text: 'Half', finishReason: 'length' }, { error: 'engine stopped' }]).ai,
      request,
      DOCUMENT,
      'compose',
    );
    expect(result).to.include({ text: 'Half', finished: false, error: 'engine stopped' });
  });

  it('never cleans up a continuation on its own', () => {
    const settled = settleDraft(
      '| a |\n',
      { text: '| b |', finishReason: 'stop' },
      DOCUMENT,
      'compose',
    );
    expect(settled.draft).to.equal('| a |\n| b |');
    expect(settled.finished).to.equal(true);
    expect(settled.echoRemoved).to.equal(false);
  });

  it('removes document text a compose reply copied, as the dialog does', async () => {
    const echoed = `${DOCUMENT}\nSee you there.`;
    const { ai } = scriptedChat([{ text: echoed }]);
    const result = await runDraft(ai, request, DOCUMENT, 'compose');
    expect(result.text).to.equal('See you there.');
    const settled = settleDraft('', { text: echoed, finishReason: 'stop' }, DOCUMENT, 'compose');
    expect(settled.echoRemoved).to.equal(true);
  });

  it('leaves a rewrite as written, since it replaces its selection', () => {
    const settled = settleDraft(
      '',
      { text: `${DOCUMENT}\nSee you there.`, finishReason: 'stop' },
      DOCUMENT,
      'rewrite',
    );
    expect(settled.echoRemoved).to.equal(false);
    expect(settled.draft).to.contain('# Garden notes');
  });
});
