/**
 * Rename must never strip a document's extension. The lists hide `.md`, but
 * rename used to seed its field with the raw `Name.md`, wholly selected, so
 * typing a new title produced an extension-less file.
 */
import { expect } from 'chai';
import {
  displayFileName,
  renameDraft,
  renamedFileName,
  renamedFromTitle,
  titleFieldName,
} from '../src/FileExplorer/file-names.js';

describe('displayFileName', () => {
  it('hides .md and nothing else', () => {
    expect(displayFileName('Spring Quote.md')).to.equal('Spring Quote');
    expect(displayFileName('Price Sheet 2026.docx')).to.equal('Price Sheet 2026.docx');
    expect(displayFileName('notes')).to.equal('notes');
  });

  it('never shows an empty label for a file named only ".md"', () => {
    expect(displayFileName('.md')).to.equal('.md');
  });
});

describe('renameDraft', () => {
  it('seeds a Markdown document with its title alone, all selected', () => {
    expect(renameDraft('Spring Quote.md', 'file')).to.deep.equal({
      value: 'Spring Quote',
      selectionEnd: 'Spring Quote'.length,
    });
  });

  it('selects only the part before a visible extension', () => {
    expect(renameDraft('Price Sheet 2026.docx', 'file')).to.deep.equal({
      value: 'Price Sheet 2026.docx',
      selectionEnd: 'Price Sheet 2026'.length,
    });
  });

  it('selects all of a name without a real extension', () => {
    expect(renameDraft('Pricing v1.2 notes', 'file').selectionEnd).to.equal(18);
    expect(renameDraft('.gitignore', 'file').selectionEnd).to.equal(10);
  });

  it('treats a folder name as a whole', () => {
    expect(renameDraft('Clients.archive', 'directory')).to.deep.equal({
      value: 'Clients.archive',
      selectionEnd: 15,
    });
  });
});

describe('renamedFileName', () => {
  it('keeps a Markdown document a Markdown document', () => {
    expect(
      renamedFileName('Hendricks Spring Quote.md', 'Hendricks - Spring 2026 Quote', 'file'),
    ).to.equal('Hendricks - Spring 2026 Quote.md');
  });

  it('does not double .md when it is typed anyway', () => {
    expect(renamedFileName('draft.md', 'renamed.md', 'file')).to.equal('renamed.md');
    expect(renamedFileName('draft.md', 'Renamed.MD', 'file')).to.equal('Renamed.MD');
  });

  it('restores a visible extension that was deleted outright', () => {
    expect(renamedFileName('Price Sheet 2026.docx', 'Prices 2027', 'file')).to.equal(
      'Prices 2027.docx',
    );
    expect(renamedFileName('logo.png', 'Logo v1.2', 'file')).to.equal('Logo v1.2.png');
  });

  it('takes a different extension as deliberate', () => {
    expect(renamedFileName('notes.txt', 'notes.csv', 'file')).to.equal('notes.csv');
  });

  it('leaves folder names exactly as typed, trimmed', () => {
    expect(renamedFileName('Clients', ' Clients 2026 ', 'directory')).to.equal('Clients 2026');
    expect(renamedFileName('Clients', 'Clients.old', 'directory')).to.equal('Clients.old');
  });

  it('returns null for an empty or unchanged name', () => {
    expect(renamedFileName('draft.md', '   ', 'file')).to.equal(null);
    expect(renamedFileName('draft.md', 'draft', 'file')).to.equal(null);
    expect(renamedFileName('Price Sheet.docx', 'Price Sheet', 'file')).to.equal(null);
  });
});

describe('the title field’s name', () => {
  it('drops the extension of every type, but not a dotfile’s dot or a version', () => {
    expect(titleFieldName('Spring Quote.md')).to.equal('Spring Quote');
    expect(titleFieldName('Price Sheet 2026.xlsx')).to.equal('Price Sheet 2026');
    expect(titleFieldName('.gitignore')).to.equal('.gitignore');
    expect(titleFieldName('README')).to.equal('README');
    expect(titleFieldName('Pricing v1.2')).to.equal('Pricing v1.2');
  });

  it('keeps the document’s type through a rename', () => {
    expect(renamedFromTitle('Q3.docx', 'Q3 review')).to.equal('Q3 review.docx');
    expect(renamedFromTitle('Q3.docx', 'Q3 review.DOCX')).to.equal('Q3 review.DOCX');
    expect(renamedFromTitle('Q3.docx', 'Q3 review.pdf')).to.equal('Q3 review.pdf.docx');
    expect(renamedFromTitle('README', 'Read me')).to.equal('Read me');
    expect(renamedFromTitle('Q3.docx', ' Q3 ')).to.equal(null);
    expect(renamedFromTitle('Q3.docx', '   ')).to.equal(null);
  });
});
