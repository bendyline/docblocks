import { expect } from 'chai';
import {
  MemoryFileSystemProvider,
  PREMERGE_COPY_LIFETIME_MS,
  conflictCopyScope,
  listConflictCopies,
  removeConflictCopy,
  writeConflictCopy,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import {
  useDocumentVersions,
  type DocumentVersionsOptions,
} from '../src/DocBlocksShell/useDocumentVersions.js';
import { act, advanceTime, renderHook } from './helpers/renderHook.js';

const DOCUMENT = 'Notes/Unicorns.md';
const SCOPE = conflictCopyScope(DOCUMENT)!;

/** The same files, seen through storage that cannot report changes by itself. */
function withoutWatch(provider: MemoryFileSystemProvider): FileSystemProvider {
  const v2 = provider.v2;
  return new Proxy(provider, {
    get(target, key, receiver) {
      if (key !== 'v2') return Reflect.get(target, key, receiver);
      return new Proxy(v2, {
        get(inner, innerKey, innerReceiver) {
          if (innerKey === 'capabilities') return { ...inner.capabilities, watch: false };
          return Reflect.get(inner, innerKey, innerReceiver);
        },
      });
    },
  });
}

async function settle(ms = 40): Promise<void> {
  await advanceTime(ms);
}

describe('useDocumentVersions', () => {
  let provider: MemoryFileSystemProvider;

  beforeEach(async () => {
    provider = new MemoryFileSystemProvider(`versions-${Date.now()}-${Math.random()}`, 'Versions');
    await provider.writeFile(DOCUMENT, 'current');
  });
  afterEach(async () => {
    await provider.v2.dispose();
  });

  const open = (options: Partial<DocumentVersionsOptions> = {}) =>
    renderHook((props: DocumentVersionsOptions) => useDocumentVersions(props), {
      provider,
      documentPath: DOCUMENT,
      ...options,
    });

  it('lists the versions waiting for review and leaves undo copies out', async () => {
    await writeConflictCopy(provider, SCOPE, 'from the Mac', { origin: 'sync', label: 'Mac' });
    await writeConflictCopy(provider, SCOPE, 'before a merge', { origin: 'premerge' });
    const hook = await open();
    await settle();
    expect(hook.result.current.scope).to.deep.equal(SCOPE);
    expect(hook.result.current.copies.map((copy) => copy.origin)).to.deep.equal(['sync']);
    await hook.unmount();
  });

  it('has nothing for a document that keeps no sidecar, or for no document', async () => {
    const json = await open({ documentPath: 'data.json' });
    await settle();
    expect(json.result.current.scope).to.equal(null);
    expect(json.result.current.copies).to.deep.equal([]);
    await json.rerender({ provider, documentPath: null });
    expect(json.result.current.copies).to.deep.equal([]);
    await json.unmount();
  });

  it('notices a version that arrives while the document is open', async () => {
    const hook = await open();
    await settle();
    expect(hook.result.current.copies).to.have.length(0);
    await act(async () => {
      await writeConflictCopy(provider, SCOPE, 'arrived later', { origin: 'sync' });
    });
    await settle(400);
    expect(hook.result.current.copies).to.have.length(1);
    await hook.unmount();
  });

  it('re-lists on a heartbeat and on request where storage cannot watch', async () => {
    const quiet = withoutWatch(provider);
    const hook = await open({ provider: quiet, heartbeatMs: 60 });
    await settle();
    const written = await writeConflictCopy(provider, SCOPE, 'arrived later', { origin: 'sync' });
    await settle(150);
    expect(hook.result.current.copies).to.have.length(1);

    await removeConflictCopy(provider, SCOPE, written.copy!);
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(hook.result.current.copies).to.have.length(0);
    await hook.unmount();
  });

  it('re-lists when the document was replaced from outside or by a merge', async () => {
    const quiet = withoutWatch(provider);
    const hook = await open({ provider: quiet, refreshToken: 1 });
    await settle();
    await writeConflictCopy(provider, SCOPE, 'set aside by a merge elsewhere', { origin: 'sync' });
    await hook.rerender({ provider: quiet, documentPath: DOCUMENT, refreshToken: 2 });
    await settle();
    expect(hook.result.current.copies).to.have.length(1);
    await hook.unmount();
  });

  it('switches documents without showing the previous one’s versions', async () => {
    await provider.writeFile('Other.md', 'other');
    await writeConflictCopy(provider, SCOPE, 'for unicorns', { origin: 'sync' });
    const hook = await open();
    await settle();
    expect(hook.result.current.copies).to.have.length(1);
    await hook.rerender({ provider, documentPath: 'Other.md' });
    expect(hook.result.current.copies).to.have.length(0);
    await settle();
    expect(hook.result.current.copies).to.have.length(0);
    await hook.unmount();
  });

  it('drops undo copies past their week when the document opens', async () => {
    const old = Date.now() - PREMERGE_COPY_LIFETIME_MS - 60_000;
    await writeConflictCopy(provider, SCOPE, 'old undo', { origin: 'premerge', capturedAt: old });
    await writeConflictCopy(provider, SCOPE, 'old but unreviewed', {
      origin: 'sync',
      capturedAt: old,
    });
    const hook = await open();
    await settle();
    expect((await listConflictCopies(provider, SCOPE)).map((copy) => copy.origin)).to.deep.equal([
      'sync',
    ]);
    expect(hook.result.current.copies).to.have.length(1);
    await hook.unmount();
  });
});
