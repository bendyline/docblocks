/**
 * Tests for useGit — the hook behind every git surface. The behaviours
 * here are the ones that fail *quietly* when they regress:
 *
 *   1. A transient capabilities failure must not hide the git UI for the
 *      rest of the page's life (the probe is memoised per page load, so a
 *      cached rejection is permanent).
 *   2. `lastResult` is a single shared slot rendered as a role="alert" by
 *      whichever dialog is open — opening a dialog must not inherit the
 *      previous operation's failure.
 *   3. The returned object *is* the GitContext.Provider value, so it must
 *      be referentially stable when nothing changed.
 */
import { expect } from 'chai';
import type {
  DocBlocksHostAPI,
  DocBlocksHostGitAPI,
  GitCapabilities,
  GitStatus,
} from '@bendyline/docblocks/host';
import { resetGitCapabilitiesCache, useGit } from '../src/Git/useGit.js';
import { act, advanceTime, renderHook } from './helpers/renderHook.js';

/** Mirrors CAPABILITIES_RETRY_MS in useGit, plus a scheduling margin. */
const PAST_RETRY_MS = 1200;

const CAPABLE: GitCapabilities = {
  gitAvailable: true,
  ghAvailable: false,
} as GitCapabilities;

function makeStatus(extra: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    detached: false,
    unborn: false,
    head: 'abc1234',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    changes: [],
    truncated: false,
    operation: null,
    ...extra,
  };
}

type HostGlobal = typeof globalThis & { docBlocksHost?: DocBlocksHostAPI };

/** Minimal repo-backed git API; individual tests override what they test. */
function makeGitApi(overrides: Partial<DocBlocksHostGitAPI> = {}): DocBlocksHostGitAPI {
  return {
    capabilities: () => Promise.resolve(CAPABLE),
    detectRepo: () =>
      Promise.resolve({ ok: true, value: { isRepo: true, repositoryId: 'repo-1' } }),
    listRemotes: () => Promise.resolve({ ok: true, value: [] }),
    onStatusChanged: () => () => undefined,
    status: () => Promise.resolve({ ok: true, value: makeStatus() }),
    ...overrides,
  } as unknown as DocBlocksHostGitAPI;
}

function installHost(gitApi: DocBlocksHostGitAPI): void {
  (globalThis as HostGlobal).docBlocksHost = {
    git: gitApi,
    shell: { openExternal: () => Promise.resolve() },
  } as unknown as DocBlocksHostAPI;
}

function useGitHook(props: { workspaceId: string | null }) {
  return useGit(null, props.workspaceId, 'light');
}

describe('useGit', () => {
  beforeEach(() => {
    resetGitCapabilitiesCache();
  });

  afterEach(() => {
    delete (globalThis as HostGlobal).docBlocksHost;
    resetGitCapabilitiesCache();
  });

  describe('capabilities probe', () => {
    it('retries a failed probe rather than hiding git for the page lifetime', async function () {
      // Real timers: the retry backoff has to elapse for real.
      this.timeout(10_000);
      // Regression (SF-4): the module-level promise cached the *rejection*,
      // so one transient IPC failure pinned `available` false forever with
      // no retry — every git surface stayed hidden until a reload.
      let calls = 0;
      installHost(
        makeGitApi({
          capabilities: () => {
            calls += 1;
            return calls === 1 ? Promise.reject(new Error('IPC blip')) : Promise.resolve(CAPABLE);
          },
        }),
      );

      const handle = await renderHook(useGitHook, { workspaceId: '/ws' });
      await advanceTime(1);
      expect(handle.result.current.available, 'first probe failed').to.equal(false);

      await advanceTime(PAST_RETRY_MS);
      expect(calls, 'the probe must be retried').to.be.greaterThan(1);
      expect(handle.result.current.available, 'git must come back after a retry').to.equal(true);
      await handle.unmount();
    });

    it('does not cache a rejection across mounts', async () => {
      let calls = 0;
      installHost(
        makeGitApi({
          capabilities: () => {
            calls += 1;
            return calls === 1 ? Promise.reject(new Error('IPC blip')) : Promise.resolve(CAPABLE);
          },
        }),
      );

      const first = await renderHook(useGitHook, { workspaceId: '/ws' });
      await advanceTime(1);
      await first.unmount();

      // A fresh mount must be able to succeed — the failed probe is not a
      // permanent verdict.
      const second = await renderHook(useGitHook, { workspaceId: '/ws' });
      await advanceTime(1);
      expect(second.result.current.available).to.equal(true);
      await second.unmount();
    });

    it('caches a successful probe — it cannot change within a session', async () => {
      let calls = 0;
      installHost(
        makeGitApi({
          capabilities: () => {
            calls += 1;
            return Promise.resolve(CAPABLE);
          },
        }),
      );

      const first = await renderHook(useGitHook, { workspaceId: '/ws' });
      await advanceTime(1);
      await first.unmount();
      const second = await renderHook(useGitHook, { workspaceId: '/ws' });
      await advanceTime(1);
      await second.unmount();

      expect(calls).to.equal(1);
    });

    it('leaves no unhandled rejection when the probe keeps failing', async function () {
      this.timeout(15_000);
      const seen: unknown[] = [];
      const onUnhandled = (reason: unknown) => seen.push(reason);
      process.on('unhandledRejection', onUnhandled);
      // Exhausting the retries warns by design; keep it out of the report.
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        installHost(makeGitApi({ capabilities: () => Promise.reject(new Error('no host')) }));
        const handle = await renderHook(useGitHook, { workspaceId: '/ws' });
        // Long enough to exhaust the bounded retries.
        await advanceTime(PAST_RETRY_MS * 3);
        expect(seen, 'the probe rejection must be handled').to.deep.equal([]);
        expect(handle.result.current.available).to.equal(false);
        await handle.unmount();
      } finally {
        console.warn = warn;
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });

  describe('lastResult', () => {
    it('clears a previous failure when a dialog is opened', async () => {
      // Regression (SF-4): lastResult is one shared slot, never cleared on
      // open, so yesterday's failed pull rendered as a role="alert" inside
      // today's commit dialog.
      installHost(
        makeGitApi({
          pull: () =>
            Promise.resolve({ ok: false, error: { code: 'unknown', message: 'Pull failed' } }),
        }),
      );
      const handle = await renderHook(useGitHook, { workspaceId: '/ws' });
      await advanceTime(1);

      await act(async () => {
        await handle.result.current.pull();
      });
      expect(handle.result.current.lastResult?.message).to.equal('Pull failed');

      await act(async () => {
        handle.result.current.openDialog({ kind: 'commit' });
      });
      expect(
        handle.result.current.lastResult,
        'a freshly opened dialog must not inherit an older failure',
      ).to.equal(null);
      await handle.unmount();
    });
  });

  describe('context value', () => {
    it('is referentially stable when nothing changed', async () => {
      // This object is passed straight to GitContext.Provider, so a fresh
      // identity each render re-rendered the status bar, toolbar, badges
      // and any open dialog on every shell render.
      installHost(makeGitApi());
      const handle = await renderHook(useGitHook, { workspaceId: '/ws' });
      await advanceTime(1);

      const before = handle.result.current;
      await handle.rerender({ workspaceId: '/ws' });
      expect(handle.result.current).to.equal(before);
      await handle.unmount();
    });

    it('still produces a new value when something actually changed', async () => {
      installHost(
        makeGitApi({
          pull: () =>
            Promise.resolve({ ok: false, error: { code: 'unknown', message: 'Pull failed' } }),
        }),
      );
      const handle = await renderHook(useGitHook, { workspaceId: '/ws' });
      await advanceTime(1);

      const before = handle.result.current;
      await act(async () => {
        await handle.result.current.pull();
      });
      expect(handle.result.current).to.not.equal(before);
      expect(handle.result.current.lastResult?.message).to.equal('Pull failed');
      await handle.unmount();
    });
  });
});
