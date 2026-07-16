import { expect } from 'chai';
import { validateExportDestinationEdit } from '../webview/src/exportDestinationEdit.js';

describe('VS Code export destination edits', () => {
  it('accepts a basename edit within the granted folder', () => {
    expect(
      validateExportDestinationEdit(
        'C:\\Exports\\Board Review.pdf',
        'C:\\Exports\\document.pdf',
        'document.pdf',
      ),
    ).to.deep.equal({ filename: 'Board Review.pdf', error: null });
    expect(
      validateExportDestinationEdit(
        'Board Review.pdf',
        'C:\\Exports\\document.pdf',
        'document.pdf',
      ),
    ).to.deep.equal({ filename: 'Board Review.pdf', error: null });
  });

  it('rejects folder changes and path-like input without a grant', () => {
    expect(
      validateExportDestinationEdit(
        'C:\\Elsewhere\\document.pdf',
        'C:\\Exports\\document.pdf',
        'document.pdf',
      ).error,
    ).to.include('Only the file name');
    expect(validateExportDestinationEdit('../document.pdf', null, 'document.pdf').error).to.include(
      'file name only',
    );
  });

  it('rejects invalid names and extensions that do not match the format', () => {
    expect(
      validateExportDestinationEdit('C:\\Exports\\bad:name.pdf', 'C:\\Exports\\old.pdf', 'old.pdf')
        .error,
    ).to.include('valid file name');
    expect(
      validateExportDestinationEdit(
        'C:\\Exports\\document.docx',
        'C:\\Exports\\document.pdf',
        'document.pdf',
      ).error,
    ).to.include('.pdf');
  });
});
