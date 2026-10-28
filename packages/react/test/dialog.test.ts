import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Dialog } from '../src/components/Dialog.js';

describe('Dialog accessibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('labels the modal, traps focus, and restores the prior focus', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    await act(async () => {
      root.render(
        createElement(
          Dialog,
          {
            title: 'Accessible dialog',
            onClose: () => undefined,
            footer: createElement('button', { type: 'button', id: 'last-action' }, 'Save'),
          },
          createElement('button', { type: 'button' }, 'Body action'),
        ),
      );
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const close = document.body.querySelector<HTMLElement>('.db-dialog-close');
    const last = document.body.querySelector<HTMLElement>('#last-action');
    expect(dialog?.getAttribute('aria-modal')).to.equal('true');
    expect(dialog?.getAttribute('aria-labelledby')).to.equal(
      document.body.querySelector('.db-dialog-title')?.id,
    );
    expect(document.activeElement).to.equal(close);

    last?.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).to.equal(close);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
    );
    expect(document.activeElement).to.equal(last);

    await act(async () => root.render(null));
    expect(document.activeElement).to.equal(trigger);
    trigger.remove();
  });

  it('keeps a hidden title labelling a top-anchored palette that Escape still closes', async () => {
    let closed = 0;
    const inputRef = { current: null as HTMLInputElement | null };
    await act(async () => {
      root.render(
        createElement(
          Dialog,
          {
            title: 'Go to document',
            onClose: () => {
              closed += 1;
            },
            placement: 'top',
            titleHidden: true,
            initialFocusRef: inputRef,
          },
          createElement('input', { ref: inputRef, 'aria-label': 'Document name' }),
        ),
      );
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const title = document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).to.equal('Go to document');
    expect(title?.className).to.equal('db-visually-hidden');
    expect(document.body.querySelector('.db-dialog-header')).to.equal(null);
    expect(document.body.querySelector('.db-dialog-close')).to.equal(null);
    expect(document.body.querySelector('.db-dialog-overlay--top')).to.not.equal(null);
    expect(document.activeElement).to.equal(inputRef.current);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(closed).to.equal(1);
  });

  // Squisq's toolbar is a size container, which the Chromium in VS Code
  // 1.85–1.97 made the containing block for a fixed overlay inside it: the
  // Export and Settings dialogs opened above the top of the webview.
  it('renders the overlay on <body>, outside the toolbar that opened it', async () => {
    container.className = 'squisq-toolbar';
    await act(async () => {
      root.render(createElement(Dialog, { title: 'Export Document', onClose: () => undefined }));
    });

    const overlay = document.body.querySelector('.db-dialog-overlay');
    expect(overlay?.parentElement).to.equal(document.body);
    expect(container.contains(overlay)).to.equal(false);
  });
});
