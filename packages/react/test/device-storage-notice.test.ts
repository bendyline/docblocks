import { expect } from 'chai';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import * as React from 'react';
import { DeviceStorageNotice } from '../src/DocBlocksShell/DeviceStorageNotice.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('DeviceStorageNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('says the documents go with the app, and offers the move', () => {
    let moves = 0;
    act(() => {
      root.render(
        createElement(DeviceStorageNotice, { onMove: () => (moves += 1), moving: false }),
      );
    });

    expect(container.textContent).to.include('deleted if you uninstall it');
    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).to.equal('Move to a folder…');
    act(() => button.click());
    expect(moves).to.equal(1);
  });

  it('holds the button while a move is under way', () => {
    act(() => {
      root.render(createElement(DeviceStorageNotice, { onMove: () => undefined, moving: true }));
    });

    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(button.disabled).to.equal(true);
    expect(button.textContent).to.equal('Moving…');
  });
});
