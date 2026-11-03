import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { OpeningNotice } from '../src/DocBlocksShell/OpeningNotice.js';
import { useOpeningNotice } from '../src/DocBlocksShell/useOpeningNotice.js';
import { advanceTime, renderHook } from './helpers/renderHook.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const delays = { noticeMs: 20, slowMs: 60 };

describe('OpeningNotice', () => {
  it('stays hidden when the document opens quickly', async () => {
    const hook = await renderHook(() => useOpeningNotice(delays), undefined);
    let stop = () => {};
    await act(async () => {
      stop = hook.result.current.track('notes/acy.md');
    });
    await act(async () => stop());
    await advanceTime(80);
    expect(hook.result.current.notice).to.equal(null);
    await hook.unmount();
  });

  it('appears for a slow open, then explains why, then clears when it finishes', async () => {
    const hook = await renderHook(() => useOpeningNotice(delays), undefined);
    let stop = () => {};
    await act(async () => {
      stop = hook.result.current.track('notes/acy.md');
    });
    await advanceTime(35);
    expect(hook.result.current.notice).to.deep.equal({ name: 'acy', slow: false });
    await advanceTime(45);
    expect(hook.result.current.notice).to.deep.equal({ name: 'acy', slow: true });
    await act(async () => stop());
    expect(hook.result.current.notice).to.equal(null);
    await hook.unmount();
  });

  it('follows the latest open and ignores the one it replaced', async () => {
    const hook = await renderHook(() => useOpeningNotice(delays), undefined);
    let stopFirst = () => {};
    let stopSecond = () => {};
    await act(async () => {
      stopFirst = hook.result.current.track('acy.md');
    });
    await advanceTime(35);
    await act(async () => {
      stopSecond = hook.result.current.track('inotes2.md');
    });
    // Already on screen, so it switches straight to the new document.
    expect(hook.result.current.notice).to.deep.equal({ name: 'inotes2', slow: false });
    await act(async () => stopFirst());
    expect(hook.result.current.notice?.name).to.equal('inotes2');
    await act(async () => stopSecond());
    expect(hook.result.current.notice).to.equal(null);
    await hook.unmount();
  });

  it('announces itself politely in plain language', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(OpeningNotice, { notice: { name: 'acy', slow: false } }));
    });
    const status = container.querySelector('.db-opening-notice');
    expect(status?.getAttribute('role')).to.equal('status');
    expect(status?.textContent).to.equal('Opening “acy”…');

    await act(async () => {
      root.render(createElement(OpeningNotice, { notice: { name: 'acy', slow: true } }));
    });
    expect(container.querySelector('.db-opening-notice')?.textContent).to.include(
      'may be downloading first',
    );
    await act(async () => root.unmount());
  });
});
