import { expect } from 'chai';
import { createRequire } from 'node:module';
import {
  LiveIndex,
  markdownChunksByCharacters,
  type SqlDatabase,
} from '@bendyline/gezel-retrieval';
import { MemoryFileSystemProviderV2 } from '@bendyline/docblocks/filesystem/memory';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  LIVE_ENGINE_PAYLOAD_FORMAT,
  createLiveIndexEngine,
  createWorkspaceIndex,
  type WorkspaceIndex,
  type WorkspaceIndexSource,
} from '@bendyline/docblocks/workspace-index';

type NodeSqlite = typeof import('node:sqlite');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqlite;

const encode = (text: string) => new TextEncoder().encode(text);
const p = parseWorkspacePath;
const APP_VERSION = `docblocks-workspace-index@test/${LIVE_ENGINE_PAYLOAD_FORMAT}`;

async function seed(files: Record<string, string>): Promise<MemoryFileSystemProviderV2> {
  const provider = new MemoryFileSystemProviderV2(`live-${Math.random()}`, 'Live engine test');
  for (const [path, text] of Object.entries(files)) {
    await provider.writeFile(p(path), encode(text), { createParents: true });
  }
  return provider;
}

/** The provider without watching, recording reads. */
function reading(provider: MemoryFileSystemProviderV2) {
  const reads: string[] = [];
  const source: WorkspaceIndexSource = {
    stat: (path) => provider.stat(path),
    readFile: (path) => {
      reads.push(path);
      return provider.readFile(path);
    },
    readDirectory: (path) => provider.readDirectory(path),
    capabilities: { watch: false },
  };
  return { source, reads };
}

/** One "launch": a live index over `db` and a workspace index using it. */
function launch(db: SqlDatabase, source: WorkspaceIndexSource) {
  const live = LiveIndex.open(db, {
    chunking: markdownChunksByCharacters(),
    appVersion: APP_VERSION,
  });
  const engine = createLiveIndexEngine(live);
  const index = createWorkspaceIndex({
    workspaceId: 'live',
    source,
    engine,
    yieldControl: () => Promise.resolve(),
    changeCoalesceMs: 0,
    minRefreshIntervalMs: 0,
  });
  index.start();
  return { live, engine, index };
}

async function ready(index: WorkspaceIndex): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = index.getStatus();
    if (status.phase === 'ready' && status.pendingCount === 0) return;
    if (status.phase === 'error') throw new Error(status.error ?? 'index failed');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('index never settled');
}

describe('persistent workspace index (live index engine)', () => {
  const files = {
    'garden.md': '# Garden notes\n\n## Pests\n\nAphids gather under the leaves.\n',
    'notes/kitchen.md': '# Kitchen\n\nRoast the tomatoes slowly.\n',
    'notes/old.md': '# Old\n\nTo be deleted while closed.\n',
  };

  it('reopens without reading unchanged documents and keeps literal search exact', async () => {
    const provider = await seed(files);
    const db = new DatabaseSync(':memory:');

    const first = reading(provider);
    const one = launch(db, first.source);
    await ready(one.index);
    expect([...first.reads].sort()).to.deep.equal([
      'garden.md',
      'notes/kitchen.md',
      'notes/old.md',
    ]);
    const literal = await one.index.search({ text: 'Aphids', matchCase: true });
    expect(literal.documents.map((document) => document.path)).to.deep.equal(['garden.md']);
    const [passage] = one.engine.find('aphids');
    expect(passage).to.include({ path: 'garden.md', lineStart: 3 });
    expect(passage?.headingPath).to.deep.equal(['Garden notes', 'Pests']);
    one.index.dispose();

    // While closed: one note deleted, one edited.
    await provider.remove(p('notes/old.md'));
    await provider.writeFile(p('notes/kitchen.md'), encode('# Kitchen\n\nBraise the leeks.\n'));

    const second = reading(provider);
    const two = launch(db, second.source);
    expect(two.live.reset).to.equal(null);
    await ready(two.index);
    expect(second.reads).to.deep.equal(['notes/kitchen.md']);
    expect(two.index.getDocument('garden.md')?.title).to.equal('Garden notes');

    const aphids = await two.index.search({ text: 'Aphids', matchCase: true });
    expect(aphids.documents[0]?.matches[0]).to.include({ line: 5, kind: 'text' });
    expect((await two.index.search({ text: 'leeks' })).documents.map((d) => d.path)).to.deep.equal([
      'notes/kitchen.md',
    ]);
    expect((await two.index.search({ text: 'tomatoes' })).documents).to.deep.equal([]);
    expect(two.live.get('notes/old.md')).to.equal(null);
    expect(two.engine.find('deleted')).to.deep.equal([]);
    two.index.dispose();
  });

  it('starts over when the stored payloads belong to another format', async () => {
    const provider = await seed(files);
    const db = new DatabaseSync(':memory:');
    const first = launch(db, reading(provider).source);
    await ready(first.index);
    first.index.dispose();

    // Same live index, but an app version written by a different payload format.
    const live = LiveIndex.open(db, {
      chunking: markdownChunksByCharacters(),
      appVersion: `${APP_VERSION}-next`,
    });
    expect(live.reset).to.equal('app');
    expect(live.stats().documents).to.equal(0);
  });
});
