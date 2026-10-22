import { EventEmitter } from 'node:events';
import { expect } from 'chai';

import { showWhenReady } from '../main/window-activation.js';

class FakeWindow extends EventEmitter {
  public readonly webContents = new EventEmitter();
  public destroyed = false;
  public visible = false;
  public shows = 0;

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public isVisible(): boolean {
    return this.visible;
  }

  public show(): void {
    this.shows += 1;
    this.visible = true;
  }
}

function track(win: FakeWindow): { firstShows: () => number } {
  let firstShows = 0;
  showWhenReady(win, () => {
    firstShows += 1;
  });
  return { firstShows: () => firstShows };
}

describe('desktop window reveal', () => {
  it('shows the window on ready-to-show', () => {
    const win = new FakeWindow();
    const { firstShows } = track(win);

    win.emit('ready-to-show');

    expect(win.shows).to.equal(1);
    expect(firstShows()).to.equal(1);
  });

  it('shows the window when the page loads but ready-to-show never fires', () => {
    // Wayland: a hidden window never paints, so ready-to-show never arrives.
    const win = new FakeWindow();
    const { firstShows } = track(win);

    win.webContents.emit('did-finish-load');

    expect(win.shows).to.equal(1);
    expect(firstShows()).to.equal(1);
  });

  it('delivers launch work once when both signals fire, in either order', () => {
    for (const order of [
      ['ready-to-show', 'did-finish-load'],
      ['did-finish-load', 'ready-to-show'],
    ]) {
      const win = new FakeWindow();
      const { firstShows } = track(win);

      for (const signal of order) {
        if (signal === 'ready-to-show') win.emit(signal);
        else win.webContents.emit(signal);
      }

      expect(win.shows, order.join(' then ')).to.equal(1);
      expect(firstShows(), order.join(' then ')).to.equal(1);
    }
  });

  it('does not show a window that is already visible', () => {
    const win = new FakeWindow();
    win.visible = true;
    const { firstShows } = track(win);

    win.webContents.emit('did-finish-load');

    expect(win.shows).to.equal(0);
    expect(firstShows()).to.equal(1);
  });

  it('ignores a window destroyed before it could be shown', () => {
    const win = new FakeWindow();
    const { firstShows } = track(win);

    win.destroyed = true;
    win.emit('ready-to-show');

    expect(win.shows).to.equal(0);
    expect(firstShows()).to.equal(0);
  });
});
