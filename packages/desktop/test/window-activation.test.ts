import { expect } from 'chai';

import { showAndFocusWindow } from '../main/window-activation.js';

interface HarnessOptions {
  appHidden?: boolean;
  windowMinimized?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const app = {
    focus(focusOptions?: { steal?: boolean }) {
      calls.push(`app.focus:${focusOptions?.steal === true ? 'steal' : 'normal'}`);
    },
    isHidden() {
      calls.push('app.isHidden');
      return options.appHidden ?? false;
    },
    show() {
      calls.push('app.show');
    },
  };
  const win = {
    focus() {
      calls.push('window.focus');
    },
    isMinimized() {
      calls.push('window.isMinimized');
      return options.windowMinimized ?? false;
    },
    restore() {
      calls.push('window.restore');
    },
    show() {
      calls.push('window.show');
    },
  };
  return { app, calls, win };
}

describe('desktop window activation', () => {
  it('activates the app before focusing a visible window on macOS', () => {
    const { app, calls, win } = createHarness();

    showAndFocusWindow(app, win, 'darwin');

    expect(calls).to.deep.equal([
      'window.isMinimized',
      'app.isHidden',
      'app.focus:steal',
      'window.show',
      'window.focus',
    ]);
  });

  it('unhides and restores the app before focusing it on macOS', () => {
    const { app, calls, win } = createHarness({ appHidden: true, windowMinimized: true });

    showAndFocusWindow(app, win, 'darwin');

    expect(calls).to.deep.equal([
      'window.isMinimized',
      'window.restore',
      'app.isHidden',
      'app.show',
      'app.focus:steal',
      'window.show',
      'window.focus',
    ]);
  });

  it('keeps the existing window-only behavior on other platforms', () => {
    const { app, calls, win } = createHarness({ appHidden: true, windowMinimized: true });

    showAndFocusWindow(app, win, 'win32');

    expect(calls).to.deep.equal([
      'window.isMinimized',
      'window.restore',
      'window.show',
      'window.focus',
    ]);
  });
});
