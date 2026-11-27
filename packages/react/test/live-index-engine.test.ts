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

/** Settled, with no stored record still waiting to be brought up to date. */
async function upToDate(index: WorkspaceIndex): Promise<void> {
  await ready(index);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (!index.getStatus().upgrading) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('stored records were never brought up to date');
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

  it('finds exactly what the in-memory index finds, whatever the query', async () => {
    const provider = await seed({
      'quotes.md': '# Quotes\n\nShe said "hello" by the \\ backslash.\n',
      'tabs.md': '# Tabs\n\n```\nname\tword\tvalue\n```\n\nA tab\tword here.\n',
      'case.md': '# Case\n\nThe ſtrange Kelvin sign, a straße in Köln.\n',
      'plain.md': '# Plain\n\nA word, another word, and words.\n',
      'split.md': '# Split\n\nends with hel\nlo starts here\n',
    });
    const memory = createWorkspaceIndex({
      workspaceId: 'memory',
      source: reading(provider).source,
      yieldControl: () => Promise.resolve(),
      changeCoalesceMs: 0,
      minRefreshIntervalMs: 0,
    });
    memory.start();
    await ready(memory);
    const live = launch(new DatabaseSync(':memory:'), reading(provider).source);
    await ready(live.index);

    const queries = [
      { text: 'hello' },
      { text: '"hello"' },
      { text: '\\' },
      { text: 'word', wholeWord: true },
      { text: 'Word', matchCase: true },
      { text: 'tab\tword' },
      { text: 'value', wholeWord: true },
      { text: 'strange' },
      { text: 'kelvin' },
      { text: 'KÖLN' },
      { text: 'hel lo' },
      { text: 'lo starts' },
      { text: 'Quotes' },
    ];
    for (const query of queries) {
      const expected = await memory.search(query);
      const actual = await live.index.search(query);
      expect(actual.documents, JSON.stringify(query)).to.deep.equal(expected.documents);
      expect(actual.skippedDocuments, JSON.stringify(query)).to.equal(expected.skippedDocuments);
    }
    // The screen is not a no-op: these all find something.
    for (const text of ['word', 'strange', 'kelvin', 'KÖLN', '"hello"', 'tab\tword']) {
      expect((await live.index.search({ text })).documents, text).to.not.deep.equal([]);
    }
    memory.dispose();
    live.index.dispose();
  });

  it('brings records an earlier version stored up to date without reading the workspace', async () => {
    const provider = await seed({
      'task.md': '---\ndue: 2026-12-05\n---\n\n# Renew passport\n\n- [x] Photos\n- [ ] Form\n',
      'plain.md': '# Plain\n\nRoast the tomatoes slowly.\n',
    });
    const db = new DatabaseSync(':memory:');
    const one = launch(db, reading(provider).source);
    await ready(one.index);
    const chunksBefore = one.live.stats();

    // Put back what the app stored before it read properties: no analyzer
    // revision, and none of the fields that revision added.
    const decoder = new TextDecoder();
    for (const document of [...one.live.documents()]) {
      const payload = JSON.parse(decoder.decode(document.payload!)) as {
        analyzer?: number;
        record: Record<string, unknown>;
      };
      delete payload.analyzer;
      delete payload.record.due;
      delete payload.record.checklist;
      one.live.upsert({
        path: document.path,
        version: document.version,
        title: String(payload.record.title),
        body: one.live.body(document.path) ?? '',
        payload: encode(JSON.stringify(payload)),
      });
    }
    one.index.dispose();

    const second = reading(provider);
    const two = launch(db, second.source);
    await upToDate(two.index);
    expect(second.reads).to.deep.equal([]);
    expect(two.index.getDocument('task.md')).to.include({
      title: 'Renew passport',
      due: '2026-12-05',
    });
    expect(two.index.getDocument('task.md')?.checklist).to.deep.equal({ done: 1, total: 2 });
    expect(two.index.getDocument('plain.md')?.due).to.equal(undefined);
    expect(two.live.stats()).to.deep.equal(chunksBefore);
    const found = await two.index.search({ text: 'tomatoes' });
    expect(found.documents.map((document) => document.path)).to.deep.equal(['plain.md']);
    two.index.dispose();

    // Rebuilt records were stored: the next launch has nothing left to do.
    const third = reading(provider);
    const three = launch(db, third.source);
    await ready(three.index);
    expect(three.index.getStatus().upgrading).to.equal(undefined);
    expect(three.index.getDocument('task.md')?.due).to.equal('2026-12-05');
    expect(third.reads).to.deep.equal([]);
    three.index.dispose();
    await provider.dispose();
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
