import { expect } from 'chai';
import { createFileSystemDocumentTarget, DocumentSession } from '@bendyline/docblocks/document';
import {
  MemoryFileSystemProvider,
  parseWorkspacePath,
  type FileSystemProvider,
  type FileSystemProviderV2,
} from '@bendyline/docblocks/filesystem';
import {
  useExternalDocumentObserver,
  type ExternalDocumentObserverOptions,
} from '../src/DocBlocksShell/useExternalDocumentObserver.js';
import { advanceTime, renderHook, type HookHandle } from './helpers/renderHook.js';

const PATH = 'note.md';

interface Harness {
  memory: MemoryFileSystemProvider;
  session: DocumentSession;
  targetKey: string;
  /** Storage that holds the same files but cannot report changes, like a phone's. */
  unwatched: FileSystemProvider;
  reads: () => number;
  stats: () => number;
  failReads: (fail: boolean) => void;
}

async function createHarness(): Promise<Harness> {
  const memory = new MemoryFileSystemProvider('device', 'Device');
  memory.seedText(PATH, 'one');
  const session = new DocumentSession({ autoSaveEnabled: false });
  const target = createFileSystemDocumentTarget(memory, PATH);
  await session.transitionTo(target, 'one');
  let reads = 0;
  let stats = 0;
  let failing = false;
  const v2 = memory.v2;
  const quiet = {
    capabilities: { ...v2.capabilities, watch: false },
    stat: (path: Parameters<FileSystemProviderV2['stat']>[0]) => {
      stats += 1;
      return v2.stat(path);
    },
    readFile: (path: Parameters<FileSystemProviderV2['readFile']>[0]) => {
      reads += 1;
      if (failing) return Promise.reject(new Error('unreachable'));
      return v2.readFile(path);
    },
  } as unknown as FileSystemProviderV2;
  return {
    memory,
    session,
    targetKey: target.key,
    unwatched: { id: memory.id, v2: quiet } as unknown as FileSystemProvider,
    reads: () => reads,
    stats: () => stats,
    failReads: (fail) => {
      failing = fail;
    },
  };
}

/** Another device or app replaces the file. */
async function changeOutside(harness: Harness, content: string): Promise<void> {
  await harness.memory.v2.writeFile(parseWorkspacePath(PATH), new TextEncoder().encode(content), {
    mode: 'replace',
  });
}

function editScope(harness: Harness) {
  return { targetKey: harness.targetKey, generation: harness.session.getSnapshot().generation };
}

describe('useExternalDocumentObserver', () => {
  let mounted: HookHandle<ExternalDocumentObserverOptions, void> | null = null;
  const mount = async (options: ExternalDocumentObserverOptions) => {
    mounted = await renderHook(useExternalDocumentObserver, options);
    return mounted;
  };
  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
  });

  it('adopts an outside change when the app comes back, on storage that cannot watch', async () => {
    const harness = await createHarness();
    await mount({
      provider: harness.unwatched,
      path: PATH,
      targetKey: harness.targetKey,
      session: harness.session,
    });
    await changeOutside(harness, 'two');
    expect(harness.session.getSnapshot().content).to.equal('one');

    window.dispatchEvent(new Event('focus'));
    await advanceTime(20);

    expect(harness.session.getSnapshot().content).to.equal('two');
    expect(harness.session.getSnapshot().status).to.equal('saved');
  });

  it('keeps unsaved edits and raises a conflict when the file changed underneath them', async () => {
    const harness = await createHarness();
    await mount({
      provider: harness.unwatched,
      path: PATH,
      targetKey: harness.targetKey,
      session: harness.session,
    });
    harness.session.edit('mine', editScope(harness));
    await changeOutside(harness, 'theirs');

    window.dispatchEvent(new Event('focus'));
    await advanceTime(20);

    const snapshot = harness.session.getSnapshot();
    expect(snapshot.status).to.equal('conflict');
    expect(snapshot.content).to.equal('mine');
    expect(snapshot.conflict?.externalContent).to.equal('theirs');
  });

  it('keeps observing the same document after its inputs change', async () => {
    const harness = await createHarness();
    const base: ExternalDocumentObserverOptions = {
      provider: harness.unwatched,
      path: PATH,
      targetKey: harness.targetKey,
      session: harness.session,
    };
    const hook = await mount(base);

    // Each known rewrite of the open file hands the hook a new token. The
    // session only accepts observations that are newer than the last one, so
    // a second rewrite is lost if the hook starts counting again.
    await changeOutside(harness, 'two');
    await hook.rerender({ ...base, refreshToken: { run: 1 } });
    await advanceTime(20);
    expect(harness.session.getSnapshot().content).to.equal('two');

    await changeOutside(harness, 'three');
    await hook.rerender({ ...base, refreshToken: { run: 2 } });
    await advanceTime(20);
    expect(harness.session.getSnapshot().content).to.equal('three');
  });

  it('checks on a heartbeat and reads the file only when its version moved', async () => {
    const harness = await createHarness();
    await mount({
      provider: harness.unwatched,
      path: PATH,
      targetKey: harness.targetKey,
      session: harness.session,
      heartbeatMs: 15,
    });
    await advanceTime(120);
    // The first beat reads once to learn the version; later beats only ask for it.
    expect(harness.reads()).to.equal(1);
    expect(harness.stats()).to.be.greaterThan(1);

    await changeOutside(harness, 'two');
    await advanceTime(60);

    expect(harness.session.getSnapshot().content).to.equal('two');
    expect(harness.reads()).to.equal(2);
  });

  it('stays quiet when a precautionary check cannot read the file', async () => {
    const harness = await createHarness();
    let failures = 0;
    await mount({
      provider: harness.unwatched,
      path: PATH,
      targetKey: harness.targetKey,
      session: harness.session,
      onCheckFailed: () => {
        failures += 1;
      },
    });
    harness.failReads(true);

    window.dispatchEvent(new Event('focus'));
    await advanceTime(20);

    expect(harness.reads()).to.equal(1);
    expect(failures).to.equal(0);
    expect(harness.session.getSnapshot().content).to.equal('one');
  });

  it('reports a failed read that follows a known rewrite', async () => {
    const harness = await createHarness();
    let failures = 0;
    harness.failReads(true);
    await mount({
      provider: harness.unwatched,
      path: PATH,
      targetKey: harness.targetKey,
      session: harness.session,
      refreshToken: { run: 1 },
      onCheckFailed: () => {
        failures += 1;
      },
    });
    await advanceTime(20);
    expect(failures).to.equal(1);
  });

  it('follows watch events for the open file and ignores other files', async () => {
    const harness = await createHarness();
    await mount({
      provider: harness.memory,
      path: PATH,
      targetKey: harness.targetKey,
      session: harness.session,
      // A watching provider never needs the heartbeat.
      heartbeatMs: 5,
    });
    await harness.memory.v2.writeFile(
      parseWorkspacePath('other.md'),
      new TextEncoder().encode('x'),
      { mode: 'create' },
    );
    await advanceTime(40);
    expect(harness.session.getSnapshot().generation).to.equal(editScope(harness).generation);

    const before = harness.session.getSnapshot().generation;
    await changeOutside(harness, 'two');
    await advanceTime(20);

    expect(harness.session.getSnapshot().content).to.equal('two');
    expect(harness.session.getSnapshot().generation).to.be.greaterThan(before);
  });

  it('observes nothing without a document', async () => {
    const harness = await createHarness();
    await mount({
      provider: harness.unwatched,
      path: null,
      targetKey: harness.targetKey,
      session: harness.session,
      heartbeatMs: 5,
    });
    await changeOutside(harness, 'two');
    window.dispatchEvent(new Event('focus'));
    await advanceTime(40);
    expect(harness.reads()).to.equal(0);
    expect(harness.session.getSnapshot().content).to.equal('one');
  });
});
