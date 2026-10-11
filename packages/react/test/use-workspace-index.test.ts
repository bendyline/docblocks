import { expect } from 'chai';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { act, renderHook } from './helpers/renderHook.js';
import {
  useWorkspaceIndex,
  type WorkspaceIndexMode,
} from '../src/WorkspaceIndex/useWorkspaceIndex.js';

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function seededProvider(id: string): Promise<MemoryFileSystemProvider> {
  const provider = new MemoryFileSystemProvider(id, 'Index hook');
  const v2 = provider.v2;
  await v2.writeFile(parseWorkspacePath('a.md'), new TextEncoder().encode('# Alpha\n'));
  return provider;
}

interface Props {
  readonly provider: MemoryFileSystemProvider | null;
  readonly workspaceId: string | null;
  readonly mode: WorkspaceIndexMode;
}

describe('useWorkspaceIndex', () => {
  it('starts eagerly when idle and disposes the index when the workspace changes', async function () {
    // happy-dom only runs idle callbacks at their 3 s timeout.
    this.timeout(10_000);
    const first = await seededProvider('hook-first');
    const hook = await renderHook(
      ({ provider, workspaceId, mode }: Props) => useWorkspaceIndex(provider, workspaceId, mode),
      { provider: first, workspaceId: 'first', mode: 'eager' },
    );
    await waitFor(() => hook.result.current.status.phase === 'ready', 'first index ready');
    const firstIndex = hook.result.current.index!;
    expect(firstIndex.getDocument('a.md')?.title).to.equal('Alpha');

    const second = await seededProvider('hook-second');
    await hook.rerender({ provider: second, workspaceId: 'second', mode: 'eager' });
    expect(firstIndex.getStatus().phase).to.equal('disposed');
    await waitFor(() => hook.result.current.index?.workspaceId === 'second', 'second index');
    await hook.unmount();
  });

  it('waits for a feature to ask in on-demand mode', async () => {
    const provider = await seededProvider('hook-on-demand');
    const hook = await renderHook(
      ({ provider: source, workspaceId, mode }: Props) =>
        useWorkspaceIndex(source, workspaceId, mode),
      { provider, workspaceId: 'on-demand', mode: 'on-demand' },
    );
    await waitFor(() => hook.result.current.index !== null, 'index created');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(hook.result.current.status.phase).to.equal('idle');

    act(() => hook.result.current.ensure());
    await waitFor(() => hook.result.current.status.phase === 'ready', 'on-demand ready');
    await hook.unmount();
  });

  it('creates no index when off', async () => {
    const provider = await seededProvider('hook-off');
    const hook = await renderHook(
      ({ provider: source, workspaceId, mode }: Props) =>
        useWorkspaceIndex(source, workspaceId, mode),
      { provider, workspaceId: 'off', mode: 'off' },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hook.result.current.index).to.equal(null);
    expect(hook.result.current.status.phase).to.equal('idle');
    await hook.unmount();
  });
});
