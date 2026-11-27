import { expect } from 'chai';
import {
  MemoryFileSystemProvider,
  conflictCopyScope,
  writeConflictCopy,
  type FileSystemEntry,
} from '@bendyline/docblocks/filesystem';
import {
  conflictCopyCandidates,
  useConflictCopyCounts,
} from '../src/FileExplorer/useConflictCopyCounts.js';
import { useWorkspaceVersionsToReview } from '../src/FileExplorer/useWorkspaceVersionsToReview.js';
import { advanceTime, renderHook } from './helpers/renderHook.js';

const file = (path: string): FileSystemEntry => ({
  kind: 'file',
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
});
const folder = (path: string): FileSystemEntry => ({
  kind: 'directory',
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
});

describe('conflictCopyCandidates', () => {
  it('checks only documents whose sidecar is already there', () => {
    const candidates = conflictCopyCandidates([
      [file('/Unicorns.md'), folder('/Unicorns_files'), file('/Plain.md'), file('/data.json')],
      [file('/Site/Page.html'), folder('/Site/Page_files'), folder('/Site/Other_files')],
    ]);
    expect(candidates).to.deep.equal([
      {
        path: 'Unicorns.md',
        scope: { directory: '/Unicorns_files/conflicts', source: false, extension: '.md' },
      },
      {
        // A published page's stored versions are versions of its Markdown source.
        path: 'Site/Page.html',
        scope: { directory: '/Site/Page_files/conflicts', source: true, extension: '.md' },
      },
    ]);
  });

  it('costs nothing in a folder with no sidecars', () => {
    expect(conflictCopyCandidates([[file('a.md'), file('b.md'), folder('Notes')]])).to.deep.equal(
      [],
    );
  });
});

describe('useConflictCopyCounts', () => {
  it('counts the versions waiting for review per listed document', async () => {
    const provider = new MemoryFileSystemProvider(`counts-${Date.now()}`, 'Counts');
    await provider.writeFile('Unicorns.md', 'current');
    await provider.writeFile('Quiet.md', 'current');
    await provider.writeBinary('Quiet_files/photo.png', new Uint8Array([1]));
    const scope = conflictCopyScope('Unicorns.md')!;
    await writeConflictCopy(provider, scope, 'one', { origin: 'sync' });
    await writeConflictCopy(provider, scope, 'two', { origin: 'local' });
    await writeConflictCopy(provider, scope, 'undo', { origin: 'premerge' });

    const listings = [await provider.readDirectory('/')];
    const hook = await renderHook(
      (props: { listings: FileSystemEntry[][] }) =>
        useConflictCopyCounts(provider, props.listings, 1_200),
      { listings },
    );
    expect(hook.result.current.size).to.equal(0);
    await advanceTime(750);
    expect([...hook.result.current]).to.deep.equal([['Unicorns.md', 2]]);

    // A listing refreshes after every save. The same documents are not counted
    // again straight away: that would be a directory read per sidecar per save.
    await provider.delete(scope.directory);
    await hook.rerender({ listings: [await provider.readDirectory('/')] });
    await advanceTime(750);
    expect([...hook.result.current]).to.deep.equal([['Unicorns.md', 2]]);
    // They are counted again once the interval has passed.
    await advanceTime(900);
    expect(hook.result.current.size).to.equal(0);
    await hook.unmount();
    await provider.v2.dispose();
  });
});

describe('useWorkspaceVersionsToReview', () => {
  /** Storage that can list a whole workspace in one pass, as the desktop app's can. */
  function enumerable(provider: MemoryFileSystemProvider): MemoryFileSystemProvider {
    const v2 = provider.v2;
    const walk = async (folder: string): Promise<FileSystemEntry[]> => {
      const out: FileSystemEntry[] = [];
      for (const entry of await provider.readDirectory(folder || '/')) {
        const path = entry.path.replace(/^\/+/, '');
        out.push({ ...entry, path });
        // Sidecars are listed but not entered, as the contract says.
        if (entry.kind === 'directory' && !entry.name.endsWith('_files')) {
          out.push(...(await walk(path)));
        }
      }
      return out;
    };
    Object.defineProperty(v2, 'enumerate', {
      configurable: true,
      value: async function* () {
        yield { entries: await walk(''), unreadable: [] };
      },
    });
    return provider;
  }

  it('finds documents with versions waiting, in folders nobody has opened', async () => {
    const provider = enumerable(new MemoryFileSystemProvider(`workspace-${Date.now()}`, 'Whole'));
    await provider.writeFile('Top.md', 'top');
    await provider.writeFile('Deep/Down/Unicorns.md', 'current');
    await provider.writeFile('Deep/Quiet.md', 'quiet');
    await provider.writeBinary('Deep/Quiet_files/photo.png', new Uint8Array([1]));
    await writeConflictCopy(provider, conflictCopyScope('Deep/Down/Unicorns.md')!, 'other', {
      origin: 'sync',
    });
    await writeConflictCopy(provider, conflictCopyScope('Top.md')!, 'undo only', {
      origin: 'premerge',
    });

    const hook = await renderHook(
      (props: { token: number }) => useWorkspaceVersionsToReview(provider, props.token),
      { token: 0 },
    );
    expect(hook.result.current).to.deep.equal([]);
    await advanceTime(1_700);
    expect(hook.result.current).to.deep.equal([{ path: 'Deep/Down/Unicorns.md', count: 1 }]);

    // The explorer saw a count change: look again without waiting for the app to come back.
    await writeConflictCopy(provider, conflictCopyScope('Top.md')!, 'another', { origin: 'local' });
    await hook.rerender({ token: 1 });
    await advanceTime(1_700);
    expect(hook.result.current.map((item) => item.path)).to.deep.equal([
      'Deep/Down/Unicorns.md',
      'Top.md',
    ]);
    await hook.unmount();
    await provider.v2.dispose();
  });

  it('stays off storage that can enumerate but cannot watch, as on a phone', async () => {
    const provider = enumerable(
      new MemoryFileSystemProvider(`workspace-phone-${Date.now()}`, 'Phone'),
    );
    await provider.writeFile('Unicorns.md', 'current');
    await writeConflictCopy(provider, conflictCopyScope('Unicorns.md')!, 'other', {
      origin: 'sync',
    });
    const v2 = provider.v2;
    let enumerations = 0;
    const original = v2.enumerate!.bind(v2);
    Object.defineProperty(v2, 'enumerate', {
      configurable: true,
      value: (...args: Parameters<typeof original>) => {
        enumerations += 1;
        return original(...args);
      },
    });
    Object.defineProperty(v2, 'capabilities', {
      configurable: true,
      value: { ...v2.capabilities, watch: false },
    });
    const hook = await renderHook(() => useWorkspaceVersionsToReview(provider, 0), undefined);
    await advanceTime(1_700);
    expect(hook.result.current).to.deep.equal([]);
    expect(enumerations).to.equal(0);
    await hook.unmount();
    await provider.v2.dispose();
  });

  it('does nothing where storage cannot list a whole workspace in one pass', async () => {
    const provider = new MemoryFileSystemProvider(`workspace-plain-${Date.now()}`, 'Plain');
    await provider.writeFile('Unicorns.md', 'current');
    await writeConflictCopy(provider, conflictCopyScope('Unicorns.md')!, 'other', {
      origin: 'sync',
    });
    let reads = 0;
    const counting = new Proxy(provider, {
      get(target, key, receiver) {
        if (key === 'readDirectory') reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const hook = await renderHook(() => useWorkspaceVersionsToReview(counting, 0), undefined);
    await advanceTime(1_700);
    expect(hook.result.current).to.deep.equal([]);
    expect(reads).to.equal(0);
    await hook.unmount();
    await provider.v2.dispose();
  });
});
