/**
 * Every new document starts in the gallery: a type from the chip row, then a
 * starter. A card creates the document at once, so the gallery never asks
 * for a name; the starter decides the document's first name and content.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  NewDocumentGallery,
  type NewDocumentGalleryChoice,
} from '../src/components/NewDocumentGallery.js';
import {
  firstFreeDocumentPath,
  NEW_DOCUMENT_TEMPLATES,
  newDocumentMarkdown,
  templatesForFormat,
} from '../src/DocBlocksShell/new-document-templates.js';
import { createNewOutsideInDocument } from '../src/DocBlocksShell/outside-in.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('NewDocumentGallery', () => {
  let container: HTMLDivElement;
  let root: Root;
  let settled: Array<NewDocumentGalleryChoice | null>;

  beforeEach(async () => {
    settled = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(NewDocumentGallery, {
          folder: 'Projects/2026',
          onSettle: (choice) => settled.push(choice),
        }),
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const dialog = () => document.querySelector<HTMLElement>('.db-dialog')!;
  const cards = () =>
    [...dialog().querySelectorAll<HTMLButtonElement>('.db-new-document-card')].map((card) =>
      card.getAttribute('aria-label'),
    );
  const chip = (label: string) =>
    [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (button) => button.textContent === label,
    )!;

  it('offers every type as one radio group, Markdown first and chosen', () => {
    const group = dialog().querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-label')).to.equal('Type');
    const radios = [...dialog().querySelectorAll('[role="radio"]')];
    expect(radios.map((radio) => radio.textContent)).to.deep.equal([
      'Markdown',
      'Document (docx)',
      'Spreadsheet (xlsx)',
      'PDF',
      'Web page',
      'Static web page',
    ]);
    expect(chip('Markdown').getAttribute('aria-checked')).to.equal('true');
  });

  it('shows every starter, with Blank first and focused', () => {
    expect(cards()).to.deep.equal(NEW_DOCUMENT_TEMPLATES.map((template) => template.label));
    expect(document.activeElement?.getAttribute('aria-label')).to.equal('Blank');
  });

  it('says which folder the document goes in', () => {
    expect(dialog().querySelector('.db-new-document-gallery-folder')?.textContent).to.equal(
      'In Projects/2026',
    );
  });

  it('dims the starters an Excel workbook cannot hold, keeping every card in place', async () => {
    await act(async () => chip('Spreadsheet (xlsx)').click());
    // Same cards in the same places, so the dialog keeps its size.
    expect(cards()).to.deep.equal(NEW_DOCUMENT_TEMPLATES.map((template) => template.label));
    const enabled = [
      ...dialog().querySelectorAll<HTMLButtonElement>('.db-new-document-card:not(:disabled)'),
    ].map((card) => card.getAttribute('aria-label'));
    expect(enabled).to.deep.equal(['Blank', 'Budget']);
    expect(dialog().textContent).to.contain('keeps only tables');
    await act(async () => chip('Document (docx)').click());
    expect(dialog().querySelectorAll('.db-new-document-card:disabled')).to.have.length(0);
  });

  it('creates from a card with the chosen type', async () => {
    await act(async () => chip('Document (docx)').click());
    expect(dialog().textContent).to.contain('each save updates the Word document');
    const plan = dialog().querySelector<HTMLButtonElement>('[aria-label="Plan"]')!;
    await act(async () => plan.click());
    expect(settled.map((choice) => choice && [choice.template.id, choice.format])).to.deep.equal([
      ['plan', 'docx'],
    ]);
  });

  it('settles null on Cancel', async () => {
    const cancel = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Cancel',
    )!;
    await act(async () => cancel.click());
    expect(settled).to.deep.equal([null]);
  });
});

describe('new document starters', () => {
  it('start with their name as the title', () => {
    for (const template of NEW_DOCUMENT_TEMPLATES) {
      const markdown = newDocumentMarkdown(template, template.name);
      expect(markdown.startsWith(`# ${template.name}\n`), template.id).to.equal(true);
    }
    const blank = NEW_DOCUMENT_TEMPLATES.find((template) => template.id === 'blank')!;
    expect(newDocumentMarkdown(blank, 'Untitled (2)')).to.equal('# Untitled (2)\n');
  });

  it('have one first heading each, so the title is the only cover', () => {
    for (const template of NEW_DOCUMENT_TEMPLATES) {
      expect(/^# /m.test(template.body), template.id).to.equal(false);
    }
  });

  it('keep Excel to the starters that are tables', () => {
    expect(templatesForFormat('xlsx').map((template) => template.id)).to.deep.equal([
      'blank',
      'budget',
    ]);
    expect(templatesForFormat('docx')).to.have.length(NEW_DOCUMENT_TEMPLATES.length);
  });
});

describe('firstFreeDocumentPath', () => {
  let provider: MemoryFileSystemProvider;

  beforeEach(() => {
    provider = new MemoryFileSystemProvider('starters', 'Starters');
  });

  afterEach(async () => {
    await provider.v2.dispose();
  });

  it('numbers past a name already taken', async () => {
    expect(await firstFreeDocumentPath(provider, '', 'Untitled', 'markdown')).to.deep.equal({
      path: '/Untitled.md',
      stem: 'Untitled',
    });
    for (const name of ['Untitled.md', 'Untitled (2).md']) {
      await provider.v2.writeFile(parseWorkspacePath(name), new TextEncoder().encode('# x\n'), {
        mode: 'create',
      });
    }
    expect(await firstFreeDocumentPath(provider, '', 'Untitled', 'markdown')).to.deep.equal({
      path: '/Untitled (3).md',
      stem: 'Untitled (3)',
    });
  });

  it('creates in the chosen folder', async () => {
    expect(
      (await firstFreeDocumentPath(provider, 'Projects/2026', 'Project plan', 'markdown')).path,
    ).to.equal('/Projects/2026/Project plan.md');
  });

  it('counts a rendered document’s hidden folder as taken', async () => {
    await createNewOutsideInDocument(provider, '/Report.docx');
    expect((await firstFreeDocumentPath(provider, '', 'Report', 'docx')).path).to.equal(
      '/Report (2).docx',
    );
    // A Markdown document of the same name is a different file.
    expect((await firstFreeDocumentPath(provider, '', 'Report', 'markdown')).path).to.equal(
      '/Report.md',
    );
  });

  it('writes a starter into a rendered document', async function () {
    this.timeout(20_000);
    const plan = NEW_DOCUMENT_TEMPLATES.find((template) => template.id === 'plan')!;
    const created = await createNewOutsideInDocument(
      provider,
      '/Project plan.docx',
      undefined,
      undefined,
      newDocumentMarkdown(plan, 'Project plan'),
    );
    expect(created.content).to.contain('# Project plan');
    expect(created.content).to.contain('## Who does what');
  });
});
