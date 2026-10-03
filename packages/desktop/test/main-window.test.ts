import { expect } from 'chai';

import { MainWindowSlot } from '../main/main-window.js';

class FakeWindow {
  public destroyed = false;

  public isDestroyed(): boolean {
    return this.destroyed;
  }
}

function createHarness(reopen?: (slot: MainWindowSlot<FakeWindow>) => Promise<void>) {
  const failures: unknown[] = [];
  let reopens = 0;
  const slot: MainWindowSlot<FakeWindow> = new MainWindowSlot<FakeWindow>(
    async () => {
      reopens += 1;
      if (reopen) await reopen(slot);
      else slot.set(new FakeWindow());
    },
    (error) => failures.push(error),
  );
  return { failures, reopens: () => reopens, slot };
}

describe('desktop main window slot', () => {
  it('never hands out a window whose native object is destroyed', () => {
    const { slot } = createHarness();
    const win = new FakeWindow();
    slot.set(win);
    expect(slot.current()).to.equal(win);

    // Electron destroys the window before emitting `closed`; anything that
    // runs in between must not reach a method that throws.
    win.destroyed = true;
    expect(slot.current()).to.equal(null);
  });

  it('keeps a replacement window when a stale window reports closed late', () => {
    const { slot } = createHarness();
    const first = new FakeWindow();
    const second = new FakeWindow();
    slot.set(first);
    slot.set(second);

    slot.release(first);

    expect(slot.current()).to.equal(second);
    slot.release(second);
    expect(slot.current()).to.equal(null);
  });

  it('leaves the first window to startup', async () => {
    const { reopens, slot } = createHarness();

    slot.ensure();
    await Promise.resolve();

    expect(reopens()).to.equal(0);
    expect(slot.current()).to.equal(null);
  });

  it('reopens once the window closed after startup, as on macOS', async () => {
    const { reopens, slot } = createHarness();
    const first = new FakeWindow();
    slot.set(first);
    first.destroyed = true;
    slot.release(first);

    slot.ensure();
    await new Promise((resolve) => setImmediate(resolve));

    expect(reopens()).to.equal(1);
    expect(slot.current()).to.be.instanceOf(FakeWindow);
    expect(slot.current()).not.to.equal(first);
  });

  it('does not reopen while a live window exists', async () => {
    const { reopens, slot } = createHarness();
    slot.set(new FakeWindow());

    slot.ensure();
    await new Promise((resolve) => setImmediate(resolve));

    expect(reopens()).to.equal(0);
  });

  it('coalesces requests that arrive while a reopen is in flight', async () => {
    let finish: () => void = () => undefined;
    const { reopens, slot } = createHarness(
      (target) =>
        new Promise<void>((resolve) => {
          finish = () => {
            target.set(new FakeWindow());
            resolve();
          };
        }),
    );
    slot.set(new FakeWindow());
    slot.release(slot.current() as FakeWindow);

    // Dock click, relaunch and Finder open-file all landing before the new
    // window exists must still produce exactly one window.
    slot.ensure();
    slot.ensure();
    slot.ensure();
    expect(reopens()).to.equal(1);

    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(slot.current()).to.be.instanceOf(FakeWindow);
  });

  it('reports a failed reopen and allows a later attempt', async () => {
    let fail = true;
    const { failures, reopens, slot } = createHarness(async (target) => {
      if (fail) throw new Error('renderer failed to load');
      target.set(new FakeWindow());
    });
    const first = new FakeWindow();
    slot.set(first);
    slot.release(first);

    slot.ensure();
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures).to.have.length(1);
    expect((failures[0] as Error).message).to.equal('renderer failed to load');
    expect(slot.current()).to.equal(null);

    fail = false;
    slot.ensure();
    await new Promise((resolve) => setImmediate(resolve));
    expect(reopens()).to.equal(2);
    expect(slot.current()).to.be.instanceOf(FakeWindow);
  });
});
