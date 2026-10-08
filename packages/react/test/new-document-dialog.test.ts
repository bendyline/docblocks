/**
 * Tests for NewDocumentDialog — the shell's New document dialog.
 *
 * It used to be a bare name prompt that always made Markdown, so the landing
 * page could not create the Word, Excel, PDF or Web page documents the
 * explorer's inline form offers. The contract the shell relies on:
 *
 *   • it offers the same types as the explorer's form, Markdown by default
 *   • Create and Enter settle with the file name carrying the chosen type's
 *     extension, replacing any pickable extension that was typed
 *   • Cancel settles `null`, and an empty name cannot be created
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NewDocumentDialog, type NewDocumentChoice } from '../src/components/NewDocumentDialog.js';
import { newFileHtmlOutput } from '../src/FileExplorer/new-file-formats.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('NewDocumentDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  let settled: Array<NewDocumentChoice | null>;

  beforeEach(async () => {
    settled = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(NewDocumentDialog, { onSettle: (choice) => settled.push(choice) }));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const nameInput = () => container.querySelector<HTMLInputElement>('input.db-git-form-input');
  const typeSelect = () => container.querySelector<HTMLSelectElement>('select.db-git-form-input');
  const createButton = () => container.querySelector<HTMLButtonElement>('.db-git-primary-btn');
  const cancelButton = () => container.querySelector<HTMLButtonElement>('.db-git-secondary-btn');

  async function typeName(value: string) {
    const field = nameInput();
    if (!field) throw new Error('name input is not rendered');
    await act(async () => {
      // Go through the native setter so React's synthetic onChange fires.
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function pickType(value: string) {
    const select = typeSelect();
    if (!select) throw new Error('type select is not rendered');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLSelectElement.prototype,
        'value',
      )?.set;
      setter?.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function clickCreate() {
    await act(async () => createButton()?.click());
  }

  it('offers the explorer’s types with Markdown selected', () => {
    const options = [...(typeSelect()?.options ?? [])].map((option) => option.value);
    expect(options).to.deep.equal([
      'markdown',
      'docx',
      'xlsx',
      'pdf',
      'web-interactive',
      'web-static',
    ]);
    expect(typeSelect()?.value).to.equal('markdown');
    expect(nameInput()?.value).to.equal('Untitled');
  });

  it('creates Markdown by default', async () => {
    await clickCreate();
    expect(settled).to.deep.equal([{ filename: 'Untitled.md', format: 'markdown' }]);
  });

  it('names the file for the chosen type', async () => {
    await typeName('Quarterly report');
    await pickType('docx');
    await clickCreate();
    expect(settled).to.deep.equal([{ filename: 'Quarterly report.docx', format: 'docx' }]);
  });

  it('lets the chosen type replace a typed extension', async () => {
    await typeName('localmodelsizes.md');
    await pickType('web-static');
    await clickCreate();
    expect(settled).to.deep.equal([{ filename: 'localmodelsizes.html', format: 'web-static' }]);
    expect(newFileHtmlOutput('web-static')).to.equal('static');
  });

  it('creates on Enter in the name field', async () => {
    await typeName('notes');
    await act(async () => {
      nameInput()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(settled).to.deep.equal([{ filename: 'notes.md', format: 'markdown' }]);
  });

  it('settles null on Cancel', async () => {
    await act(async () => cancelButton()?.click());
    expect(settled).to.deep.equal([null]);
  });

  it('cannot create without a name before the extension', async () => {
    await typeName('  .md ');
    expect(createButton()?.disabled).to.equal(true);
    await clickCreate();
    expect(settled).to.deep.equal([]);
  });
});
