import { expect } from 'chai';
import {
  parseAiWorkspacePassages,
  workspacePassageUri,
  type AiChatEvent,
  type AiChatRequest,
  type DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import type { WorkspaceIndex, WorkspacePassageHit } from '@bendyline/docblocks/workspace-index';
import {
  findTextForPassage,
  findWorkspacePassages,
  withWorkspaceGrounding,
  workspaceCatalogId,
} from '../src/Ai/workspace-grounding.js';

const hit = (n: number, overrides: Partial<WorkspacePassageHit> = {}): WorkspacePassageHit => ({
  path: `notes/note ${n}.md`,
  title: `Note ${n}`,
  headingPath: [`Note ${n}`, 'Section'],
  lineStart: n,
  lineEnd: n + 2,
  snippet: `snippet ${n}`,
  ranges: [],
  score: 1 / n,
  meaning: true,
  text: `Passage ${n} text.`,
  ...overrides,
});

function fakeIndex(
  hits: WorkspacePassageHit[] | (() => Promise<WorkspacePassageHit[]>),
  ranked = true,
): { index: WorkspaceIndex; calls: unknown[] } {
  const calls: unknown[] = [];
  const index = {
    getStatus: () => ({ ranked }),
    find: async (query: string, options: unknown) => {
      calls.push({ query, options });
      return typeof hits === 'function' ? hits() : hits;
    },
  } as unknown as WorkspaceIndex;
  return { index, calls };
}

describe('workspace grounding', () => {
  it('names a workspace with a stable DNS-label catalog id and builds citation URIs', () => {
    const id = workspaceCatalogId('Some Workspace/ID');
    expect(id).to.match(/^ws-[0-9a-f]{16}$/);
    expect(workspaceCatalogId('Some Workspace/ID')).to.equal(id);
    expect(workspaceCatalogId('other')).to.not.equal(id);
    expect(workspacePassageUri(id, 'a b/c.md', 3, 5)).to.equal(
      `knowledge://local/${id}/a%20b/c.md#line=3-5`,
    );
    expect(workspacePassageUri(id, 'c.md', 4, 4)).to.equal(`knowledge://local/${id}/c.md#line=4`);
  });

  it('offers passages found by meaning, with their text, that the wire accepts', async () => {
    const { index, calls } = fakeIndex([hit(1), hit(2, { meaning: undefined }), hit(3)]);
    const passages = await findWorkspacePassages(index, 'w1', '  garden pests  ', {
      exclude: new Set(['open.md']),
    });
    expect(passages.map((passage) => passage.title)).to.deep.equal([
      'Note 1 › Section',
      'Note 3 › Section',
    ]);
    expect(passages[0]?.text).to.equal('Passage 1 text.');
    expect(parseAiWorkspacePassages(passages)).to.deep.equal(passages);
    expect(calls[0]).to.deep.include({ query: 'garden pests' });
    expect((calls[0] as { options: { text: boolean; exclude: Set<string> } }).options).to.include({
      text: true,
    });
  });

  it('leaves out passages far behind the best one by meaning', async () => {
    const passages = await findWorkspacePassages(
      fakeIndex([
        // Fused order puts a word match first; similarity decides admission.
        hit(1, { similarity: 0.6 }),
        hit(2, { similarity: 0.71 }),
        hit(3, { similarity: 0.63 }),
        // No similarity (an older engine): judged by the floor alone, as before.
        hit(4),
      ]).index,
      'w1',
      'q',
    );
    expect(passages.map((passage) => passage.title)).to.deep.equal([
      'Note 2 › Section',
      'Note 3 › Section',
      'Note 4 › Section',
    ]);
  });

  it('leaves out a note whose path the citation grammar cannot name', async () => {
    const long = `${'deep/'.repeat(60)}note.md`;
    const passages = await findWorkspacePassages(
      fakeIndex([hit(1, { path: long }), hit(2)]).index,
      'w1',
      'q',
    );
    expect(passages.map((passage) => passage.title)).to.deep.equal(['Note 2 › Section']);
  });

  it('lands Find on a passage by its first line, cut at a word', () => {
    expect(findTextForPassage('\n  Pests  \nAphids return.')).to.equal('Pests');
    expect(
      findTextForPassage('Aphids cluster on new growth every May, and ladybirds follow them soon.'),
    ).to.equal('Aphids cluster on new growth every May, and ladybirds');
  });

  it('caps passages by count and characters', async () => {
    const many = Array.from({ length: 12 }, (_, n) => hit(n + 1));
    expect(await findWorkspacePassages(fakeIndex(many).index, 'w1', 'q')).to.have.length(6);
    const long = Array.from({ length: 5 }, (_, n) => hit(n + 1, { text: 'x'.repeat(3_900) }));
    const passages = await findWorkspacePassages(fakeIndex(long).index, 'w1', 'q');
    expect(passages.reduce((sum, passage) => sum + passage.text.length, 0)).to.be.at.most(12_000);
    expect(passages).to.have.length(3);
  });

  it('offers nothing without ranking, in time, or on failure', async () => {
    expect(await findWorkspacePassages(fakeIndex([hit(1)], false).index, 'w1', 'q')).to.deep.equal(
      [],
    );
    expect(await findWorkspacePassages(null, 'w1', 'q')).to.deep.equal([]);
    const slow = fakeIndex(() => new Promise(() => undefined)).index;
    expect(await findWorkspacePassages(slow, 'w1', 'q', { deadlineMs: 10 })).to.deep.equal([]);
    const failing = fakeIndex(() => Promise.reject(new Error('worker stopped'))).index;
    expect(await findWorkspacePassages(failing, 'w1', 'q')).to.deep.equal([]);
  });

  describe('withWorkspaceGrounding', () => {
    function fakeAi() {
      const sent: AiChatRequest[] = [];
      let cancels = 0;
      const ai = {
        status: async () => ({ kind: 'unavailable', reason: 'opt-out' }),
        chat(request: AiChatRequest, _onEvent: (event: AiChatEvent) => void) {
          sent.push(request);
          return {
            done: Promise.resolve({
              ok: true as const,
              value: { text: 'ok', model: 'm', finishReason: 'stop' as const, usage: null },
            }),
            cancel: () => {
              cancels += 1;
            },
          };
        },
      } as unknown as DocBlocksHostAiAPI;
      return { ai, sent, cancels: () => cancels };
    }
    const request: AiChatRequest = {
      messages: [{ role: 'user', content: 'Draft a note' }],
      purpose: 'write',
      knowledgeQuery: 'garden pests',
    };
    const passage = { uri: 'knowledge://local/ws-1/a.md#line=1', title: 'A', text: 'aphids' };

    it('adds passages to requests that search knowledge and keeps the other methods', async () => {
      const { ai, sent } = fakeAi();
      const grounded = withWorkspaceGrounding(ai, async () => [passage]);
      expect(grounded.status).to.equal(ai.status);
      const result = await grounded.chat(request, () => undefined).done;
      expect(result.ok).to.equal(true);
      expect(sent[0]?.workspacePassages).to.deep.equal([passage]);

      await grounded.chat({ ...request, knowledgeQuery: undefined }, () => undefined).done;
      expect(sent[1]?.workspacePassages).to.equal(undefined);
    });

    it('sends the request unchanged when grounding finds nothing or fails', async () => {
      const { ai, sent } = fakeAi();
      await withWorkspaceGrounding(ai, async () => []).chat(request, () => undefined).done;
      await withWorkspaceGrounding(ai, () => Promise.reject(new Error('no index'))).chat(
        request,
        () => undefined,
      ).done;
      expect(sent.map((entry) => entry.workspacePassages)).to.deep.equal([undefined, undefined]);
    });

    it('never starts a request cancelled while passages are found', async () => {
      const { ai, sent } = fakeAi();
      let release: (value: never[]) => void = () => undefined;
      const grounded = withWorkspaceGrounding(
        ai,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const handle = grounded.chat(request, () => undefined);
      handle.cancel();
      release([]);
      const result = await handle.done;
      expect(result.ok).to.equal(false);
      expect(!result.ok && result.error.code).to.equal('cancelled');
      expect(sent).to.have.length(0);
    });
  });
});
