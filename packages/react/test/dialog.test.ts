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

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const close = container.querySelector<HTMLElement>('.db-dialog-close');
    const last = container.querySelector<HTMLElement>('#last-action');
    expect(dialog?.getAttribute('aria-modal')).to.equal('true');
    expect(dialog?.getAttribute('aria-labelledby')).to.equal(
      container.querySelector('.db-dialog-title')?.id,
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
});
