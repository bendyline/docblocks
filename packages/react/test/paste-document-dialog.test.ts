/**
 * The paste-or-drop dialog acts on a paste at once, keeps typing for the
 * Create button, and hands pasted files to the import path.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PasteDocumentDialog } from '../src/DocBlocksShell/PasteDocumentDialog.js';
import type { PastedContent } from '../src/DocBlocksShell/pasted-document.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

/** Write through the prototype setter so React's value tracker sees a change. */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function pasteEvent(flavours: Record<string, string>, files: File[] = []): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => flavours[type] ?? '', files, types: Object.keys(flavours) },
  });
  return event;
}

describe('PasteDocumentDialog', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let contents: PastedContent[];
  let fileBatches: File[][];
  let closed: number;

  beforeEach(async () => {
    contents = [];
    fileBatches = [];
    closed = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(PasteDocumentDialog, {
          title: 'Start from something you have',
          notice: 'Paste below instead.',
          onContent: (content) => contents.push(content),
          onFiles: (files) => fileBatches.push(files),
          onClose: () => (closed += 1),
        }),
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function target(): HTMLTextAreaElement {
    const field = document.querySelector<HTMLTextAreaElement>('.db-paste-document-target');
    if (!field) throw new Error('paste target missing');
    return field;
  }

  function button(name: string): HTMLButtonElement {
    const match = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.db-dialog button'),
    ).find((candidate) => candidate.textContent?.trim() === name);
    if (!match) throw new Error(`${name} button missing`);
    return match;
  }

  it('says why it opened and takes the paste focus', () => {
    expect(document.querySelector('.db-paste-document-notice')?.textContent).to.equal(
      'Paste below instead.',
    );
    expect(document.activeElement).to.equal(target());
  });

  it('creates the document as soon as text is pasted', async () => {
    const event = pasteEvent({ 'text/plain': '# Plan', 'text/html': '<h1>Plan</h1>' });
    await act(async () => target().dispatchEvent(event));
    expect(event.defaultPrevented).to.equal(true);
    expect(contents).to.deep.equal([{ text: '# Plan', html: '<h1>Plan</h1>' }]);
  });

  it('hands a pasted file to the import path', async () => {
    const file = new File(['x'], 'report.docx');
    await act(async () => target().dispatchEvent(pasteEvent({}, [file])));
    expect(fileBatches).to.deep.equal([[file]]);
    expect(contents).to.deep.equal([]);
  });

  it('creates from typed text only when asked', async () => {
    expect(button('Create document').disabled).to.equal(true);
    await act(async () => typeInto(target(), 'Notes for Friday'));
    expect(contents).to.deep.equal([]);
    await act(async () => button('Create document').click());
    expect(contents).to.deep.equal([{ text: 'Notes for Friday' }]);
  });

  it('closes on Cancel', async () => {
    await act(async () => button('Cancel').click());
    expect(closed).to.equal(1);
  });
});
