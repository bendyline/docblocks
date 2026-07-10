/**
 * Tests for useGitStatus — the hook that subscribes to the host's
 * per-root status stream. Behaviors that must not regress:
 *
 *   1. Subscribes with the given rootPath when enabled; status is null
 *      until the listener pushes.
 *   2. Dedupe: a JSON-identical payload does not change the status
 *      reference (no repaint for a permanently-dirty tree).
 *   3. A genuinely different payload does update.
 *   4. Unsubscribes on unmount and on rootPath change (resubscribing
 *      with the new root, status reset to null).
 *   5. Disabled / null gitApi / null rootPath → never subscribes.
 *   6. refresh() calls gitApi.status and applies an ok result (and
 *      ignores an error result).
 *
 * scheduleRefresh's 1500 ms trailing debounce is not timed here — the
 * harness uses real timers, so we only assert it doesn't fire a status
 * call synchronously; the applied-result path is covered via refresh().
 */
import { expect } from 'chai';
import type { DocBlocksHostGitAPI, GitResult, GitStatus } from '@bendyline/docblocks/host';
import { useGitStatus } from '../src/Git/useGitStatus.js';
import { act, advanceTime, renderHook } from './helpers/renderHook.js';

function makeStatus(extra: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    detached: false,
    unborn: false,
    head: 'abc1234',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    changes: [{ path: '/a.md', worktree: 'modified', conflicted: false }],
    truncated: false,
    operation: null,
    ...extra,
  };
}

interface Subscription {
  rootPath: string;
  listener: (status: GitStatus) => void;
  unsubscribeCalls: number;
}

interface FakeGit {
  api: DocBlocksHostGitAPI;
  subscriptions: Subscription[];
  statusCalls: string[];
}

function makeFakeGit(statusResult: GitResult<GitStatus>): FakeGit {
  const subscriptions: Subscription[] = [];
  const statusCalls: string[] = [];
  const api = {
    onStatusChanged(rootPath: string, listener: (status: GitStatus) => void) {
      const sub: Subscription = { rootPath, listener, unsubscribeCalls: 0 };
      subscriptions.push(sub);
      return () => {
        sub.unsubscribeCalls += 1;
      };
    },
    status(rootPath: string) {
      statusCalls.push(rootPath);
      return Promise.resolve(statusResult);
    },
  } as unknown as DocBlocksHostGitAPI;
  return { api, subscriptions, statusCalls };
}

interface HookProps {
  gitApi: DocBlocksHostGitAPI | null;
  rootPath: string | null;
  enabled: boolean;
}

function useGitStatusHook(props: HookProps) {
  return useGitStatus(props.gitApi, props.rootPath, props.enabled);
}

describe('useGitStatus', () => {
  it('subscribes with the given rootPath; status null until the listener pushes', async () => {
    const fake = makeFakeGit({ ok: true, value: makeStatus() });
    const handle = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: true,
    });
    expect(fake.subscriptions).to.have.length(1);
    expect(fake.subscriptions[0].rootPath).to.equal('/root-a');
    expect(handle.result.current.status).to.equal(null);

    const pushed = makeStatus();
    await act(async () => {
      fake.subscriptions[0].listener(pushed);
    });
    expect(handle.result.current.status).to.equal(pushed);
    await handle.unmount();
  });

  it('dedupes a JSON-identical payload — status reference does not change', async () => {
    const fake = makeFakeGit({ ok: true, value: makeStatus() });
    const handle = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: true,
    });
    const first = makeStatus();
    const identicalClone = JSON.parse(JSON.stringify(first)) as GitStatus;
    await act(async () => {
      fake.subscriptions[0].listener(first);
    });
    await act(async () => {
      fake.subscriptions[0].listener(identicalClone);
    });
    expect(handle.result.current.status).to.equal(first);
    await handle.unmount();
  });

  it('a different payload updates status', async () => {
    const fake = makeFakeGit({ ok: true, value: makeStatus() });
    const handle = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: true,
    });
    const first = makeStatus();
    const second = makeStatus({ branch: 'feature', ahead: 2 });
    await act(async () => {
      fake.subscriptions[0].listener(first);
    });
    await act(async () => {
      fake.subscriptions[0].listener(second);
    });
    expect(handle.result.current.status).to.equal(second);
    await handle.unmount();
  });

  it('unsubscribes on unmount', async () => {
    const fake = makeFakeGit({ ok: true, value: makeStatus() });
    const handle = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: true,
    });
    expect(fake.subscriptions[0].unsubscribeCalls).to.equal(0);
    await handle.unmount();
    expect(fake.subscriptions[0].unsubscribeCalls).to.equal(1);
  });

  it('unsubscribes and resubscribes when rootPath changes; status resets to null', async () => {
    const fake = makeFakeGit({ ok: true, value: makeStatus() });
    const handle = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: true,
    });
    await act(async () => {
      fake.subscriptions[0].listener(makeStatus());
    });
    expect(handle.result.current.status).to.not.equal(null);

    await handle.rerender({ gitApi: fake.api, rootPath: '/root-b', enabled: true });
    expect(fake.subscriptions[0].unsubscribeCalls).to.equal(1);
    expect(fake.subscriptions).to.have.length(2);
    expect(fake.subscriptions[1].rootPath).to.equal('/root-b');
    expect(handle.result.current.status).to.equal(null);

    // The stale (unsubscribed) listener must be ignored.
    await act(async () => {
      fake.subscriptions[0].listener(makeStatus({ branch: 'stale' }));
    });
    expect(handle.result.current.status).to.equal(null);
    await handle.unmount();
  });

  it('never subscribes when disabled or gitApi/rootPath is null', async () => {
    const fake = makeFakeGit({ ok: true, value: makeStatus() });

    const disabled = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: false,
    });
    expect(fake.subscriptions).to.have.length(0);
    expect(disabled.result.current.status).to.equal(null);
    await disabled.unmount();

    const noApi = await renderHook(useGitStatusHook, {
      gitApi: null,
      rootPath: '/root-a',
      enabled: true,
    });
    expect(fake.subscriptions).to.have.length(0);
    expect(noApi.result.current.status).to.equal(null);
    await noApi.unmount();

    const noRoot = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: null,
      enabled: true,
    });
    expect(fake.subscriptions).to.have.length(0);
    expect(noRoot.result.current.status).to.equal(null);
    await noRoot.unmount();
  });

  it('refresh() calls gitApi.status with the rootPath and applies an ok result', async () => {
    const fetched = makeStatus({ branch: 'refreshed' });
    const fake = makeFakeGit({ ok: true, value: fetched });
    const handle = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: true,
    });
    await act(async () => {
      handle.result.current.refresh();
    });
    await advanceTime(1); // let the .then microtask settle inside act
    expect(fake.statusCalls).to.deep.equal(['/root-a']);
    expect(handle.result.current.status).to.equal(fetched);
    await handle.unmount();
  });

  it('refresh() ignores an error result', async () => {
    const fake = makeFakeGit({
      ok: false,
      error: { code: 'not-a-repository', message: 'not a repo' },
    });
    const handle = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: true,
    });
    await act(async () => {
      handle.result.current.refresh();
    });
    await advanceTime(1);
    expect(fake.statusCalls).to.deep.equal(['/root-a']);
    expect(handle.result.current.status).to.equal(null);
    await handle.unmount();
  });

  it('refresh() is a no-op when disabled', async () => {
    const fake = makeFakeGit({ ok: true, value: makeStatus() });
    const handle = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: false,
    });
    await act(async () => {
      handle.result.current.refresh();
    });
    await advanceTime(1);
    expect(fake.statusCalls).to.deep.equal([]);
    expect(handle.result.current.status).to.equal(null);
    await handle.unmount();
  });

  it('scheduleRefresh() does not fire a status call synchronously (trailing debounce)', async () => {
    const fake = makeFakeGit({ ok: true, value: makeStatus() });
    const handle = await renderHook(useGitStatusHook, {
      gitApi: fake.api,
      rootPath: '/root-a',
      enabled: true,
    });
    await act(async () => {
      handle.result.current.scheduleRefresh();
    });
    expect(fake.statusCalls).to.deep.equal([]);
    await handle.unmount();
  });
});
