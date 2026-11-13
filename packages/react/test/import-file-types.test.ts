import { expect } from 'chai';
import { IMPORT_ACCEPT, importingMessage } from '../src/DocBlocksShell/import-file-types.js';

describe('import file types', () => {
  it('names a single file while it imports', () => {
    expect(importingMessage([{ name: 'notes.md' }])).to.equal('Importing “notes.md”…');
  });

  it('warns that converting a document takes a moment', () => {
    expect(importingMessage([{ name: 'plan.docx' }])).to.equal(
      'Importing “plan.docx”… Converting documents can take a few seconds.',
    );
    expect(importingMessage([{ name: 'a.md' }, { name: 'b.pdf' }])).to.equal(
      'Importing 2 files… Converting documents can take a few seconds.',
    );
  });

  it('lets the picker offer everything the importer takes', () => {
    const accepted = IMPORT_ACCEPT.split(',');
    for (const extension of ['.md', '.docx', '.pptx', '.pdf', '.xlsx', '.csv', '.html', '.zip']) {
      expect(accepted).to.include(extension);
    }
    expect(accepted).to.include('image/*');
  });
});
