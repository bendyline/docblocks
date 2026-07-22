import { expect } from 'chai';
import path from 'node:path';

import { exportSaveErrorMessage } from '../main/export-save-error.js';

describe('desktop export save errors', () => {
  const target = path.join('private', 'exports', 'resume4.docx');

  for (const code of ['EACCES', 'EBUSY', 'EPERM']) {
    it(`explains a ${code} destination failure without exposing its path`, () => {
      const message = exportSaveErrorMessage(nodeError(code), target);

      expect(message).to.include('resume4.docx');
      expect(message).to.include('open in another app');
      expect(message).to.include('permission');
      expect(message).to.include('choose a different export location');
      expect(message).not.to.include('private');
      expect(message).not.to.include('.tmp');
    });
  }

  it('explains a full destination', () => {
    const message = exportSaveErrorMessage(nodeError('ENOSPC'), target);

    expect(message).to.include("isn't enough space");
    expect(message).to.include('resume4.docx');
    expect(message).not.to.include('private');
  });

  it('explains a read-only destination', () => {
    const message = exportSaveErrorMessage(nodeError('EROFS'), target);

    expect(message).to.include('destination is read-only');
    expect(message).to.include('resume4.docx');
    expect(message).not.to.include('private');
  });

  it('leaves unexpected failures available for normal diagnostics', () => {
    expect(exportSaveErrorMessage(nodeError('EIO'), target)).to.equal(null);
    expect(exportSaveErrorMessage(new Error('converter failed'), target)).to.equal(null);
  });
});

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`native failure at ${targetForDiagnostic()}`), { code });
}

function targetForDiagnostic(): string {
  return path.join('private', 'exports', '.resume4.docx.123.uuid.tmp');
}
