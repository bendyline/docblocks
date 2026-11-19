import { expect } from 'chai';
import { installNativeWakeLock, type WakeLockTarget } from '../src/wake-lock';

/** A document whose visibility the test controls. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  readonly defaultView = new EventTarget();
  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function fixture() {
  const doc = new FakeDocument();
  const navigator = {} as Navigator;
  const calls: boolean[] = [];
  installNativeWakeLock(
    async (on) => {
      calls.push(on);
    },
    { document: doc as unknown as Document, navigator } as WakeLockTarget,
  );
  // Installing resets native; tests look at what follows.
  calls.length = 0;
  return { doc, wakeLock: navigator.wakeLock, calls };
}

describe('mobile wake lock', () => {
  it('keeps the screen on while any lock is held', async () => {
    const { wakeLock, calls } = fixture();
    const first = await wakeLock.request('screen');
    const second = await wakeLock.request();
    expect(calls).to.deep.equal([true]);
    await first.release();
    expect(calls).to.deep.equal([true]);
    expect(first.released).to.equal(true);
    expect(second.released).to.equal(false);
    await second.release();
    expect(calls).to.deep.equal([true, false]);
  });

  it('releases every lock when the page is hidden, as browsers do', async () => {
    const { doc, wakeLock, calls } = fixture();
    const lock = await wakeLock.request('screen');
    let events = 0;
    lock.addEventListener('release', () => (events += 1));
    lock.onrelease = () => (events += 1);
    doc.setVisibility('hidden');
    expect(lock.released).to.equal(true);
    expect(events).to.equal(2);
    expect(calls).to.deep.equal([true, false]);
    // Releasing again changes nothing.
    await lock.release();
    expect(events).to.equal(2);
    expect(calls).to.deep.equal([true, false]);
  });

  it('refuses a lock while the page is hidden, then grants one when it returns', async () => {
    const { doc, wakeLock, calls } = fixture();
    doc.setVisibility('hidden');
    let error: unknown;
    await wakeLock.request('screen').catch((cause: unknown) => (error = cause));
    expect(error).to.be.instanceOf(DOMException);
    expect((error as DOMException).name).to.equal('NotAllowedError');
    doc.setVisibility('visible');
    await wakeLock.request('screen');
    expect(calls).to.deep.equal([true]);
  });

  it('resets native on install, so a reloaded page holds nothing', () => {
    const calls: boolean[] = [];
    installNativeWakeLock(
      async (on) => {
        calls.push(on);
      },
      { document: new FakeDocument() as unknown as Document, navigator: {} as Navigator },
    );
    expect(calls).to.deep.equal([false]);
  });

  it('keeps working when native refuses', async () => {
    const navigator = {} as Navigator;
    installNativeWakeLock(() => Promise.reject(new Error('not implemented')), {
      document: new FakeDocument() as unknown as Document,
      navigator,
    });
    const lock = await navigator.wakeLock.request('screen');
    await lock.release();
    expect(lock.released).to.equal(true);
  });
});
