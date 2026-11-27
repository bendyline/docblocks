import { expect } from 'chai';
import { createRequire } from 'node:module';
import { LiveIndex, markdownChunksByCharacters } from '@bendyline/gezel-retrieval';
import { MemoryFileSystemProviderV2 } from '@bendyline/docblocks/filesystem/memory';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  LIVE_ENGINE_PAYLOAD_FORMAT,
  createLiveIndexEngine,
  createWorkspaceIndex,
  type WorkspaceIndex,
} from '@bendyline/docblocks/workspace-index';
import {
  loadRetrievalCorpus,
  scoreRanking,
  summarizeRanking,
  type RetrievalCorpus,
} from '../src/retrieval-corpus.js';

/**
 * Search by words over character chunks, measured 2026-11-21: every lexical
 * query's note in the top 5 (one miss allowed here), nDCG@10 0.812 over all
 * answerable queries. A drop below is a ranking regression, or a corpus
 * change that needs these re-measured.
 */
const LEXICAL_HIT5 = 23 / 24;
const ALL_NDCG10 = 0.8;

type NodeSqlite = typeof import('node:sqlite');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqlite;

async function settled(index: WorkspaceIndex): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    const status = index.getStatus();
    if (status.phase === 'ready' && status.pendingCount === 0) return;
    if (status.phase === 'error') throw new Error(status.error ?? 'index failed');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('index never settled');
}

/**
 * The corpus behind `npm run eval:workspace-retrieval`. The eval needs the
 * embedding model; this keeps the fixture valid and holds the line on search
 * by words, which every device has, with or without a model.
 */
describe('workspace retrieval corpus', function () {
  this.timeout(30_000);
  let corpus: RetrievalCorpus;

  before(() => {
    corpus = loadRetrievalCorpus();
  });

  it('judges every query against notes that hold the answers', () => {
    expect(corpus.notes.length).to.be.at.least(80);
    const kinds = new Map<string, number>();
    for (const query of corpus.queries) kinds.set(query.kind, (kinds.get(query.kind) ?? 0) + 1);
    expect(kinds.get('lexical')).to.be.at.least(20);
    expect(kinds.get('paraphrase')).to.be.at.least(20);
    expect(kinds.get('detail')).to.be.at.least(10);
    expect(kinds.get('none')).to.be.at.least(6);
  });

  it('finds notes by their words without an embedding model', async () => {
    const provider = new MemoryFileSystemProviderV2('retrieval-corpus', 'Retrieval corpus');
    for (const note of corpus.notes) {
      await provider.writeFile(parseWorkspacePath(note.path), new TextEncoder().encode(note.text), {
        createParents: true,
      });
    }
    // A device without the model: character chunks, BM25 only.
    const live = LiveIndex.open(new DatabaseSync(':memory:'), {
      chunking: markdownChunksByCharacters(),
      appVersion: `docblocks-workspace-index@test/${LIVE_ENGINE_PAYLOAD_FORMAT}`,
    });
    const engine = createLiveIndexEngine(live);
    const index = createWorkspaceIndex({
      workspaceId: 'retrieval-corpus',
      source: {
        stat: (path) => provider.stat(path),
        readFile: (path) => provider.readFile(path),
        readDirectory: (path) => provider.readDirectory(path),
        capabilities: { watch: false },
      },
      engine,
      yieldControl: () => Promise.resolve(),
      changeCoalesceMs: 0,
      minRefreshIntervalMs: 0,
    });
    index.start();
    await settled(index);
    const scores = corpus.queries.map((query) =>
      scoreRanking(query, engine.find(query.query, { limit: 60, perDocument: 3 })),
    );
    index.dispose();

    const lexical = summarizeRanking(scores.filter((score) => score.kind === 'lexical'));
    const all = summarizeRanking(scores);
    expect(lexical.hit5, 'lexical queries: answering note in the top 5').to.be.at.least(
      LEXICAL_HIT5,
    );
    expect(all.ndcg10, 'all answerable queries: nDCG@10').to.be.at.least(ALL_NDCG10);
  });
});
