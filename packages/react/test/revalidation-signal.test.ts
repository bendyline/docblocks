import { expect } from 'chai';
import { publishFileSystemChangeHint } from '@bendyline/docblocks/filesystem';
import type { DocBlocksHostAPI } from '@bendyline/docblocks/host';
import {
  subscribeRevalidationSignal,
  type RevalidationReason,
} from '../src/hooks/revalidation-signal.js';

type HostGlobal = typeof globalThis & { docBlocksHost?: Partial<DocBlocksHostAPI> };

describe('subscribeRevalidationSignal', () => {
  let clock = 0;
  let reasons: RevalidationReason[] = [];
  let stop: () => void = () => {};
  const subscribe = () => {
    stop = subscribeRevalidationSignal((reason) => reasons.push(reason), {
      now: () => clock,
      minIntervalMs: 2_000,
      idleMs: 10_000,
    });
  };

  beforeEach(() => {
    clock = 100_000;
    reasons = [];
  });
  afterEach(() => {
    stop();
    delete (globalThis as HostGlobal).docBlocksHost;
  });

  it('signals when the window or tab comes back and when the network returns', () => {
    subscribe();
    window.dispatchEvent(new Event('focus'));
    clock += 5_000;
    document.dispatchEvent(new Event('visibilitychange'));
    clock += 5_000;
    window.dispatchEvent(new Event('online'));
    clock += 5_000;
    window.dispatchEvent(new Event('pageshow'));
    expect(reasons).to.deep.equal(['focus', 'visible', 'online', 'visible']);
  });

  it('signals at once when storage reports a change after a quiet spell', () => {
    subscribe();
    publishFileSystemChangeHint('workspace');
    expect(reasons).to.deep.equal(['storage']);
  });

  it('holds a storage report that follows another signal, instead of dropping it', async () => {
    stop = subscribeRevalidationSignal((reason) => reasons.push(reason), {
      minIntervalMs: 60,
      idleMs: 10_000,
    });
    window.dispatchEvent(new Event('focus'));
    // The look that focus caused may have happened before this change landed.
    publishFileSystemChangeHint('workspace');
    publishFileSystemChangeHint('workspace');
    publishFileSystemChangeHint(null);
    expect(reasons).to.deep.equal(['focus']);
    await new Promise((resolve) => setTimeout(resolve, 120));
    // A burst of reports is one more look, not three.
    expect(reasons).to.deep.equal(['focus', 'storage']);
  });

  it('forgets a held storage report once unsubscribed', async () => {
    stop = subscribeRevalidationSignal((reason) => reasons.push(reason), {
      minIntervalMs: 40,
      idleMs: 10_000,
    });
    window.dispatchEvent(new Event('focus'));
    publishFileSystemChangeHint('workspace');
    stop();
    await new Promise((resolve) => setTimeout(resolve, 90));
    publishFileSystemChangeHint('workspace');
    expect(reasons).to.deep.equal(['focus']);
  });

  it('collapses the burst of events that one return produces into one signal', () => {
    subscribe();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    clock += 1_999;
    window.dispatchEvent(new Event('focus'));
    expect(reasons).to.deep.equal(['focus']);
    clock += 1;
    window.dispatchEvent(new Event('focus'));
    expect(reasons).to.deep.equal(['focus', 'focus']);
  });

  it('treats the first key or pointer press after a quiet spell as a return', () => {
    subscribe();
    clock += 9_999;
    window.dispatchEvent(new Event('keydown'));
    expect(reasons).to.deep.equal([]);
    // Steady typing never re-checks.
    for (let press = 0; press < 5; press += 1) {
      clock += 3_000;
      window.dispatchEvent(new Event('keydown'));
    }
    expect(reasons).to.deep.equal([]);
    clock += 10_000;
    window.dispatchEvent(new Event('pointerdown'));
    expect(reasons).to.deep.equal(['input']);
  });

  it('follows the native app resume signal and releases it on unsubscribe', () => {
    const listeners = new Set<() => void>();
    (globalThis as HostGlobal).docBlocksHost = {
      lifecycle: {
        onPrepareClose: () => () => {},
        onResume: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
    subscribe();
    for (const listener of listeners) listener();
    expect(reasons).to.deep.equal(['resume']);
    stop();
    expect(listeners.size).to.equal(0);
  });

  it('stays silent after unsubscribe', () => {
    subscribe();
    stop();
    stop();
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    expect(reasons).to.deep.equal([]);
  });
});
