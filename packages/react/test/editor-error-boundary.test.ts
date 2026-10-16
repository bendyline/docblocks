/**
 * EditorErrorBoundary keeps an editor render failure inside the editor area.
 * Without it React unmounts the entire shell -- file tree, workspace picker
 * and all -- and leaves a blank page.
 */
import { expect } from 'chai';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorErrorBoundary } from '../src/DocBlocksShell/EditorErrorBoundary.js';

describe('EditorErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalError: typeof console.error;
  let broken = false;

  /** Throws for as long as `broken` is set, however often React retries. */
  function Editor() {
    if (broken) throw new Error('Position 393 outside of fragment');
    return createElement('p', { className: 'editor' }, 'editing');
  }

  function render(resetKey: string) {
    return act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          createElement('nav', { className: 'files' }, 'file tree'),
          createElement(EditorErrorBoundary, { resetKey }, createElement(Editor)),
        ),
      );
    });
  }

  beforeEach(() => {
    // React reports every error a boundary catches; that is expected here.
    originalError = console.error;
    console.error = () => undefined;
    broken = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    console.error = originalError;
  });

  const alert = () => container.querySelector('[role="alert"]');

  it('renders the editor when nothing throws', async () => {
    await render('a.md-1');
    expect(container.querySelector('.editor')?.textContent).to.equal('editing');
    expect(alert()).to.equal(null);
  });

  it('replaces only the editor with a recoverable message', async () => {
    broken = true;
    await render('a.md-1');
    expect(alert()?.textContent).to.contain('This document couldn’t be displayed');
    expect(alert()?.textContent).to.contain('Position 393 outside of fragment');
    // The rest of the shell is still mounted.
    expect(container.querySelector('.files')?.textContent).to.equal('file tree');
  });

  it('tries again on request', async () => {
    broken = true;
    await render('a.md-1');
    const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button');
    expect(retry?.textContent).to.equal('Try again');
    broken = false;
    await act(async () => retry!.click());
    expect(alert()).to.equal(null);
    expect(container.querySelector('.editor')?.textContent).to.equal('editing');
  });

  it('starts fresh for another document', async () => {
    broken = true;
    await render('a.md-1');
    expect(alert()).to.not.equal(null);
    broken = false;
    await render('b.md-2');
    expect(alert()).to.equal(null);
    expect(container.querySelector('.editor')?.textContent).to.equal('editing');
  });
});
