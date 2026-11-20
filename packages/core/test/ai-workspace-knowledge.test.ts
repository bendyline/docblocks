import { expect } from 'chai';
import {
  WORKSPACE_KNOWLEDGE_CATALOG_ID,
  withWorkspacePassages,
  type KnowledgeRetrievedPassage,
  type KnowledgeRetriever,
} from '../src/host/ai-workspace-knowledge.js';
import { parseAiWorkspacePassages } from '../src/host/ai-wire-policy.js';

const passage = (n: number, text = `curated ${n}`): KnowledgeRetrievedPassage => ({
  uri: `knowledge://bendyline/wiki/doc-${n}`,
  title: `Doc ${n}`,
  text,
  catalogId: 'wiki',
  version: '1',
});

const workspace = (n: number, text = `note ${n}`) => ({
  uri: `knowledge://local/ws-1/notes/${n}.md#line=1-3`,
  title: `Note ${n}`,
  text,
});

function client(passages: KnowledgeRetrievedPassage[], fails?: Error): KnowledgeRetriever {
  return {
    retrieve: async () => {
      if (fails) throw fails;
      return { reranked: true, passages };
    },
  };
}

const query = { query: 'q', maxResults: 4, maxCharacters: 1_000 };

describe('workspace passages in knowledge retrieval', () => {
  it('leaves the client alone without workspace passages', () => {
    const curated = client([passage(1)]);
    expect(withWorkspacePassages(curated, undefined)).to.equal(curated);
    expect(withWorkspacePassages(curated, [])).to.equal(curated);
    expect(withWorkspacePassages(null, [])).to.equal(null);
  });

  it('alternates catalog and workspace passages within the result limit', async () => {
    const merged = withWorkspacePassages(client([passage(1), passage(2), passage(3)]), [
      workspace(1),
      workspace(2),
      workspace(3),
    ]);
    const result = await merged!.retrieve(query);
    expect(result.reranked).to.equal(true);
    expect(result.passages.map((p) => p.title)).to.deep.equal([
      'Doc 1',
      'Note 1',
      'Doc 2',
      'Note 2',
    ]);
    expect(result.passages[1]).to.include({
      catalogId: WORKSPACE_KNOWLEDGE_CATALOG_ID,
      version: 'local',
    });
  });

  it('skips a passage that would overrun the character budget', async () => {
    const merged = withWorkspacePassages(client([passage(1, 'x'.repeat(900))]), [
      workspace(1, 'y'.repeat(200)),
      workspace(2, 'short'),
    ]);
    const result = await merged!.retrieve(query);
    expect(result.passages.map((p) => p.text.length)).to.deep.equal([900, 5]);
  });

  it('keeps workspace passages when the catalogs fail or are absent, not when cancelled', async () => {
    const failing = withWorkspacePassages(client([], new Error('down')), [workspace(1)]);
    expect((await failing!.retrieve(query)).passages.map((p) => p.title)).to.deep.equal(['Note 1']);
    const alone = withWorkspacePassages(null, [workspace(1)]);
    expect((await alone!.retrieve(query)).reranked).to.equal(false);

    const controller = new AbortController();
    const cancelled = withWorkspacePassages(
      {
        retrieve: async () => {
          controller.abort();
          throw new Error('aborted');
        },
      },
      [workspace(1)],
    );
    const error = await cancelled!
      .retrieve(query, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).to.equal('aborted');
  });

  it('accepts only bounded knowledge://local passages on the wire', () => {
    expect(parseAiWorkspacePassages([workspace(1)])).to.deep.equal([workspace(1)]);
    expect(
      parseAiWorkspacePassages([{ ...workspace(1), uri: 'knowledge://bendyline/x/y' }]),
    ).to.equal(null);
    expect(parseAiWorkspacePassages([{ ...workspace(1), uri: 'https://example.com' }])).to.equal(
      null,
    );
    expect(parseAiWorkspacePassages([{ ...workspace(1), extra: 1 }])).to.equal(null);
    expect(parseAiWorkspacePassages(Array.from({ length: 7 }, (_, n) => workspace(n)))).to.equal(
      null,
    );
    expect(
      parseAiWorkspacePassages(
        Array.from({ length: 4 }, (_, n) => workspace(n, 'z'.repeat(3_500))),
      ),
    ).to.equal(null);
  });
});
