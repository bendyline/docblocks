import { expect } from 'chai';
import { MemoryFileSystemProviderV2 } from '../src/filesystem/memory-provider-v2.js';
import type { FileSystemEntrySnapshot } from '../src/filesystem/v2.js';
import { parseWorkspacePath, type WorkspacePath } from '../src/filesystem/workspace-path.js';
import {
  DOCUMENT_ANALYZER_REVISION,
  analyzeDocumentBytes,
  createMemoryEngine,
  createWorkspaceIndex,
  type EngineAnalysis,
  type StoredDocument,
  type WorkspaceIndex,
  type WorkspaceIndexEngine,
  type WorkspaceIndexOptions,
  type WorkspaceIndexSource,
} from '../src/workspace-index/index.js';

const encode = (text: string) => new TextEncoder().encode(text);
const p = (path: string): WorkspacePath => parseWorkspacePath(path);
let sequence = 0;

async function seed(files: Record<string, string>): Promise<MemoryFileSystemProviderV2> {
  const provider = new MemoryFileSystemProviderV2(`properties-${++sequence}`, 'Properties test');
  for (const [path, text] of Object.entries(files)) {
    await provider.writeFile(p(path), encode(text), { createParents: true });
  }
  return provider;
}

/** A read-only source that records reads and can mark files as held in the cloud. */
function source(
  provider: MemoryFileSystemProviderV2,
  options: { readonly onlineOnly?: (path: string) => boolean } = {},
): { readonly source: WorkspaceIndexSource; readonly reads: string[] } {
  const reads: string[] = [];
  const mark = <Entry extends FileSystemEntrySnapshot | null>(entry: Entry): Entry =>
    entry && entry.kind === 'file' && options.onlineOnly?.(entry.path)
      ? ({ ...entry, onlineOnly: true } as Entry)
      : entry;
  return {
    reads,
    source: {
      capabilities: { watch: false },
      stat: async (path) => mark(await provider.stat(path)),
      readDirectory: async (path) => (await provider.readDirectory(path)).map(mark),
      readFile: (path) => {
        reads.push(path);
        return provider.readFile(path);
      },
    },
  };
}

function createIndex(
  indexSource: WorkspaceIndexSource,
  overrides: Partial<WorkspaceIndexOptions> = {},
): WorkspaceIndex {
  let clock = 0;
  return createWorkspaceIndex({
    workspaceId: 'test',
    source: indexSource,
    yieldControl: () => Promise.resolve(),
    now: () => (clock += 1),
    changeCoalesceMs: 0,
    minRefreshIntervalMs: 0,
    ...overrides,
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Listed, nothing queued, and no stored record still waiting to be brought up to date. */
const settled = (index: WorkspaceIndex) => () => {
  const status = index.getStatus();
  return status.phase === 'ready' && !status.upgrading;
};

const TASK = [
  '---',
  'due: 2026-12-05T09:00',
  'category: Home',
  'tags: [travel]',
  'repeat: yearly',
  '---',
  '',
  '# Renew passport',
  '',
  '- [x] Photos',
  '- [ ] Form',
  '- [ ] Post it',
  '',
].join('\n');

describe('workspace index: document properties', () => {
  it('carries due, category, repeat, completion and checklist progress', async () => {
    const provider = await seed({
      'Tasks/Active/Renew passport.md': TASK,
      'Tasks/Done/Pay water bill.md': '---\ncompleted: 2026-11-20\ncategory: Money\n---\n\nPaid.\n',
      'Notes/Plain.md': '# Plain\n\nNo properties here.\n',
      'Notes/Odd.md': '---\ndue: sometime\nrepeat: fortnightly\n---\n\n- a plain item\n',
    });
    const index = createIndex(source(provider).source);
    index.start();
    try {
      await waitFor(settled(index), 'ready');
      const task = index.getDocument('Tasks/Active/Renew passport.md');
      expect(task).to.include({ due: '2026-12-05T09:00', category: 'Home', repeat: 'yearly' });
      expect(task?.tags).to.deep.equal(['travel']);
      expect(task?.checklist).to.deep.equal({ done: 1, total: 3 });
      expect(task?.completed).to.equal(undefined);

      const done = index.getDocument('Tasks/Done/Pay water bill.md');
      expect(done).to.include({ completed: '2026-11-20', category: 'Money' });
      expect(done?.checklist).to.equal(undefined);

      for (const path of ['Notes/Plain.md', 'Notes/Odd.md']) {
        const plain = index.getDocument(path);
        expect(plain).to.not.have.any.keys('due', 'category', 'repeat', 'completed', 'checklist');
      }
    } finally {
      index.dispose();
      await provider.dispose();
    }
  });

  it('follows a property edit when the document changes', async () => {
    const provider = await seed({ 'a.md': '---\ndue: 2026-12-05\n---\n\nText.\n' });
    const index = createIndex(source(provider).source);
    index.start();
    try {
      await waitFor(settled(index), 'ready');
      expect(index.getDocument('a.md')?.due).to.equal('2026-12-05');
      await provider.writeFile(
        p('a.md'),
        encode('---\ndue: 2026-12-09\ncompleted: true\n---\n\nText.\n'),
      );
      index.invalidate('a.md');
      await waitFor(() => index.getDocument('a.md')?.due === '2026-12-09', 'the new due date');
      expect(index.getDocument('a.md')?.completed).to.equal(true);
    } finally {
      index.dispose();
      await provider.dispose();
    }
  });

  it('reads properties from the opening block of a document too large to parse', async () => {
    const big = `---\ndue: 2026-12-05\ncategory: Work\n---\n\n# Big\n\n- [x] one\n- [ ] two\n\n${'filler line\n'.repeat(400)}`;
    const analyzed = await analyzeDocumentBytes(
      { path: p('big.md'), sourcePath: p('big.md'), format: 'markdown', lastModified: '' },
      encode(big).buffer as ArrayBuffer,
      { maxParseBytes: 512 },
    );
    expect(analyzed.record).to.include({
      content: 'lines',
      issue: 'parse-limit',
      due: '2026-12-05',
      category: 'Work',
    });
    expect(analyzed.record.checklist).to.deep.equal({ done: 1, total: 2 });
  });
});

describe('workspace index: records stored by an earlier analyzer', () => {
  /** What an older version of the app would have stored: no property fields. */
  async function storedBefore(
    provider: MemoryFileSystemProviderV2,
    path: string,
    analyzer: number | undefined,
  ): Promise<StoredDocument> {
    const entry = (await provider.stat(p(path))) as FileSystemEntrySnapshot;
    return {
      record: {
        path: p(path),
        sourcePath: p(path),
        format: 'markdown',
        lastModified: entry.lastModified,
        title: 'Stored title',
        outline: [],
        wordCount: 3,
        content: 'full',
      },
      characters: 10,
      version: entry.version,
      ...(analyzer === undefined ? {} : { analyzer }),
    };
  }

  /** An engine restoring `stored`, rebuilding from `bodies` the way a persistent one does. */
  function engineWith(
    stored: ReadonlyMap<WorkspacePath, StoredDocument>,
    bodies: Readonly<Record<string, string>> | null,
  ) {
    const inner = createMemoryEngine();
    const calls = { analyzed: [] as string[], rebuilt: [] as string[] };
    const engine: WorkspaceIndexEngine = {
      restore: () => Promise.resolve(stored),
      analyze: (identity, version, data, options) => {
        calls.analyzed.push(identity.path);
        return inner.analyze(identity, version, data, options);
      },
      ...(bodies
        ? {
            async reanalyze(identity, _version, options): Promise<EngineAnalysis | null> {
              calls.rebuilt.push(identity.path);
              const body = bodies[identity.path];
              if (body === undefined) return null;
              const analyzed = await analyzeDocumentBytes(
                identity,
                encode(body).buffer as ArrayBuffer,
                options,
              );
              return { record: analyzed.record, characters: analyzed.text?.characters ?? 0 };
            },
          }
        : {}),
      forget: (path) => inner.forget(path),
      search: (documents, query, options) => inner.search(documents, query, options),
      dispose: () => inner.dispose(),
    };
    return { engine, calls };
  }

  it('rebuilds them from the text the engine kept, without reading the workspace', async () => {
    const provider = await seed({ 'task.md': TASK, 'other.md': '# Other\n' });
    const { engine, calls } = engineWith(
      new Map([
        [p('task.md'), await storedBefore(provider, 'task.md', 1)],
        [p('other.md'), await storedBefore(provider, 'other.md', DOCUMENT_ANALYZER_REVISION)],
      ]),
      { 'task.md': TASK },
    );
    const probe = source(provider);
    const index = createIndex(probe.source, { engine });
    const upgradingSeen: number[] = [];
    index.subscribe(() => {
      const upgrading = index.getStatus().upgrading;
      if (upgrading) upgradingSeen.push(upgrading);
    });
    index.start();
    try {
      await waitFor(settled(index), 'ready');
      expect(probe.reads).to.deep.equal([]);
      expect(calls.analyzed).to.deep.equal([]);
      expect(calls.rebuilt).to.deep.equal(['task.md']);
      expect(index.getDocument('task.md')).to.include({
        title: 'Renew passport',
        due: '2026-12-05T09:00',
      });
      // A record at the current revision is trusted as it is.
      expect(index.getDocument('other.md')?.title).to.equal('Stored title');
      expect(index.getStatus().upgrading).to.equal(undefined);
      expect(index.getStatus().analyzedCount).to.equal(2);
    } finally {
      index.dispose();
      await provider.dispose();
    }
  });

  it('reads the file once when the engine kept no text for it', async () => {
    const provider = await seed({ 'task.md': TASK });
    const { engine, calls } = engineWith(
      new Map([[p('task.md'), await storedBefore(provider, 'task.md', 1)]]),
      {},
    );
    const probe = source(provider);
    const index = createIndex(probe.source, { engine });
    index.start();
    try {
      await waitFor(
        () => settled(index)() && index.getDocument('task.md')?.due !== undefined,
        'the rebuilt record',
      );
      expect(calls.rebuilt).to.deep.equal(['task.md']);
      expect(probe.reads).to.deep.equal(['task.md']);
      expect(index.getDocument('task.md')?.due).to.equal('2026-12-05T09:00');
      expect(index.getStatus().analyzedCount).to.equal(1);
    } finally {
      index.dispose();
      await provider.dispose();
    }
  });

  it('reads the file when the engine cannot rebuild at all', async () => {
    const provider = await seed({ 'task.md': TASK });
    const { engine } = engineWith(
      new Map([[p('task.md'), await storedBefore(provider, 'task.md', 1)]]),
      null,
    );
    const probe = source(provider);
    const index = createIndex(probe.source, { engine });
    index.start();
    try {
      await waitFor(
        () => settled(index)() && index.getDocument('task.md')?.due !== undefined,
        'the rebuilt record',
      );
      expect(probe.reads).to.deep.equal(['task.md']);
    } finally {
      index.dispose();
      await provider.dispose();
    }
  });

  it('never downloads a file the cloud holds just to bring its record up to date', async () => {
    const provider = await seed({ 'task.md': TASK });
    const { engine } = engineWith(
      new Map([[p('task.md'), await storedBefore(provider, 'task.md', 1)]]),
      {},
    );
    const probe = source(provider, { onlineOnly: () => true });
    const index = createIndex(probe.source, { engine });
    index.start();
    try {
      await waitFor(settled(index), 'ready');
      expect(probe.reads).to.deep.equal([]);
      expect(index.getDocument('task.md')).to.include({ title: 'Stored title', content: 'full' });
    } finally {
      index.dispose();
      await provider.dispose();
    }
  });

  it('takes records from an engine that tracks no revision as current', async () => {
    const provider = await seed({ 'task.md': TASK });
    const { engine, calls } = engineWith(
      new Map([[p('task.md'), await storedBefore(provider, 'task.md', undefined)]]),
      { 'task.md': TASK },
    );
    const probe = source(provider);
    const index = createIndex(probe.source, { engine });
    index.start();
    try {
      await waitFor(settled(index), 'ready');
      expect(calls.rebuilt).to.deep.equal([]);
      expect(probe.reads).to.deep.equal([]);
      expect(index.getDocument('task.md')?.title).to.equal('Stored title');
    } finally {
      index.dispose();
      await provider.dispose();
    }
  });
});
