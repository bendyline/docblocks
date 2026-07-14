import { expect } from 'chai';
import { updateExportTargetExtension } from '../src/Export/export-destination.js';

describe('export destination', () => {
  it('updates the extension without discarding a custom filename', () => {
    expect(updateExportTargetExtension('C:\\Exports\\Board Review.pdf', 'document.docx')).to.equal(
      'C:\\Exports\\Board Review.docx',
    );
  });

  it('adds an extension to a typed basename that has none', () => {
    expect(updateExportTargetExtension('Board Review', 'document.pdf')).to.equal(
      'Board Review.pdf',
    );
  });

  it('preserves URI query and fragment suffixes', () => {
    expect(
      updateExportTargetExtension('vscode-vfs://host/report.pdf?rev=1#page', 'report.zip'),
    ).to.equal('vscode-vfs://host/report.zip?rev=1#page');
  });
});
