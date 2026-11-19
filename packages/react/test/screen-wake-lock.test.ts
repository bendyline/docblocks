import { expect } from 'chai';
import { holdScreenWakeLock } from '../src/hooks/screen-wake-lock.js';

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

class FakeSentinel extends EventTarget {
  released = false;
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('holdScreenWakeLock', () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'wakeLock');
  let sentinels: FakeSentinel[];
  beforeEach(() => {
    sentinels = [];
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          const sentinel = new FakeSentinel();
          sentinels.push(sentinel);
          return sentinel;
        },
      },
    });
  });
  afterEach(() => {
    if (descriptor) Object.defineProperty(navigator, 'wakeLock', descriptor);
    else delete (navigator as { wakeLock?: unknown }).wakeLock;
  });

  it('holds a lock, asks again after the page returns, and releases it', async () => {
    const doc = new FakeDocument();
    const release = holdScreenWakeLock(doc as unknown as Document);
    await settle();
    expect(sentinels).to.have.length(1);

    // Hiding the page drops the lock, as the platform does.
    doc.setVisibility('hidden');
    await sentinels[0]!.release();
    doc.setVisibility('visible');
    await settle();
    expect(sentinels).to.have.length(2);

    release();
    expect(sentinels[1]!.released).to.equal(true);
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    await settle();
    expect(sentinels).to.have.length(2);
  });

  it('does nothing where the API is missing', () => {
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
    expect(() => holdScreenWakeLock(new FakeDocument() as unknown as Document)()).not.to.throw();
  });
});
