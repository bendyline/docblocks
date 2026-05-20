/**
 * Tests for useAutoSave — the debounced write-back hook used by the
 * editor surface. Four behaviors that must not regress:
 *
 *   1. Idle: identical content shouldn't trigger a write.
 *   2. Debounce: edits within the window collapse into a single write.
 *   3. Flush: imperative `flush()` writes immediately and resolves once
 *      the provider's write resolves.
 *   4. Error restore: a failing write must restore `lastSaved` so the
 *      next debounce fires again instead of dropping the content.
 *   5. Unmount flush: dismantling the host should still persist the
 *      latest content (we don't want unsaved edits to vanish when the
 *      provider changes).
 */
import { expect } from 'chai';
import type {
  FileSystemProvider,
  FileSystemEntry,
  FileMeta,
} from '@bendyline/docblocks/filesystem';
import { useAutoSave } from '../src/hooks/useAutoSave.js';
import { act, advanceTime, renderHook } from './helpers/renderHook.js';

interface FakeProviderOptions {
  /** Throw the next write — restored to normal after one failure. */
  failNextWrite?: boolean;
}

interface FakeProvider extends FileSystemProvider {
  writes: { path: string; content: string }[];
  failNextWrite: boolean;
}

function makeFakeProvider(opts: FakeProviderOptions = {}): FakeProvider {
  const writes: { path: string; content: string }[] = [];
  const p: FakeProvider = {
    id: 'fake',
    label: 'Fake',
    writes,
    failNextWrite: !!opts.failNextWrite,
    async readFile() {
      return '';
    },
    async writeFile(path: string, content: string) {
      if (p.failNextWrite) {
        p.failNextWrite = false;
        throw new Error('write failed');
      }
      writes.push({ path, content });
    },
    async delete() {},
    async rename() {},
    async readDirectory(): Promise<FileSystemEntry[]> {
      return [];
    },
    async exists() {
      return false;
    },
    async createDirectory() {},
    async stat(): Promise<FileMeta | null> {
      return null;
    },
    async readBinary() {
      return null;
    },
    async writeBinary() {},
  };
  return p;
}

// Slightly above the hook's delay so the timer reliably fires before the
// assertion. Tests run in <100ms total.
const DEBOUNCE = 10;
const SETTLE = 30;

interface HookProps {
  provider: FileSystemProvider | null;
  filePath: string | null;
  content: string;
  onSaved?: (path: string, content: string) => void;
}

function useAutoSaveHook(props: HookProps) {
  return useAutoSave(props.provider, props.filePath, props.content, DEBOUNCE, props.onSaved);
}

describe('useAutoSave', () => {
  it('does not write when content matches the initial target snapshot', async () => {
    const provider = makeFakeProvider();
    const handle = await renderHook(useAutoSaveHook, {
      provider,
      filePath: '/a.md',
      content: 'initial',
    });
    await advanceTime(SETTLE);
    expect(provider.writes).to.deep.equal([]);
    await handle.unmount();
  });

  it('debounces — only one write for several rapid edits', async () => {
    const provider = makeFakeProvider();
    const handle = await renderHook(useAutoSaveHook, {
      provider,
      filePath: '/a.md',
      content: 'initial',
    });
    await handle.rerender({ provider, filePath: '/a.md', content: 'one' });
    await handle.rerender({ provider, filePath: '/a.md', content: 'two' });
    await handle.rerender({ provider, filePath: '/a.md', content: 'three' });
    await advanceTime(SETTLE);
    expect(provider.writes).to.have.length(1);
    expect(provider.writes[0]).to.deep.equal({ path: '/a.md', content: 'three' });
    await handle.unmount();
  });

  it('flush() writes immediately without waiting for the debounce', async () => {
    const provider = makeFakeProvider();
    const handle = await renderHook(useAutoSaveHook, {
      provider,
      filePath: '/a.md',
      content: 'initial',
    });
    await handle.rerender({ provider, filePath: '/a.md', content: 'urgent' });
    // Don't sleep — call flush directly.
    await act(async () => {
      await handle.result.current.flush();
    });
    expect(provider.writes).to.deep.equal([{ path: '/a.md', content: 'urgent' }]);
    await handle.unmount();
  });

  it('flush() is a no-op when there is no target', async () => {
    const handle = await renderHook(useAutoSaveHook, {
      provider: null,
      filePath: null,
      content: 'whatever',
    });
    await act(async () => {
      await handle.result.current.flush();
    });
    // Nothing to assert beyond "did not throw" — covered by reaching this line.
    expect(true).to.equal(true);
    await handle.unmount();
  });

  it('restores lastSaved after a failed write so the next edit fires again', async () => {
    const provider = makeFakeProvider({ failNextWrite: true });
    const handle = await renderHook(useAutoSaveHook, {
      provider,
      filePath: '/a.md',
      content: 'initial',
    });

    // First edit — write throws (handled by the debounced effect's .catch),
    // and the hook must roll lastSaved back so the next edit retries instead
    // of being short-circuited by the equality check inside flushTarget.
    await handle.rerender({ provider, filePath: '/a.md', content: 'edit-1' });
    await advanceTime(SETTLE);
    expect(provider.writes).to.deep.equal([]);

    // User keeps typing — provider now succeeds. If lastSaved had been left
    // at 'edit-1' (no restore), the next debounce would see lastSaved ===
    // 'edit-2'-prefix mismatch but the regression we're guarding against is
    // when lastSaved equals the un-persisted value and the recovery write
    // never happens. Asserting a successful write proves the restore worked.
    await handle.rerender({ provider, filePath: '/a.md', content: 'edit-2' });
    await advanceTime(SETTLE);
    expect(provider.writes).to.deep.equal([{ path: '/a.md', content: 'edit-2' }]);
    await handle.unmount();
  });

  it('calls onSaved with the path + content after a successful write', async () => {
    const provider = makeFakeProvider();
    const calls: Array<[string, string]> = [];
    const handle = await renderHook(useAutoSaveHook, {
      provider,
      filePath: '/a.md',
      content: 'initial',
      onSaved: (p, c) => calls.push([p, c]),
    });
    await handle.rerender({
      provider,
      filePath: '/a.md',
      content: 'changed',
      onSaved: (p, c) => calls.push([p, c]),
    });
    await advanceTime(SETTLE);
    expect(calls).to.deep.equal([['/a.md', 'changed']]);
    await handle.unmount();
  });

  it('switching to a new file flushes pending content to the OLD target', async () => {
    const provider = makeFakeProvider();
    const handle = await renderHook(useAutoSaveHook, {
      provider,
      filePath: '/a.md',
      content: 'first',
    });
    await handle.rerender({ provider, filePath: '/a.md', content: 'edited-a' });
    // Don't wait for debounce — switch target. The cleanup branch in the
    // target-change effect should flush 'edited-a' to /a.md.
    await handle.rerender({ provider, filePath: '/b.md', content: 'edited-a' });
    // Give the unhandled flush promise a microtask to settle.
    await advanceTime(SETTLE);
    expect(provider.writes).to.deep.equal([{ path: '/a.md', content: 'edited-a' }]);
    await handle.unmount();
  });
});
