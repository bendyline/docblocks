import { expect } from 'chai';
import path from 'node:path';

import {
  findExportTargetAccess,
  isInExportDirectory,
  isInRememberedExportDirectory,
  resolveExportTarget,
  resolveRequestedExportTarget,
  sanitizeExportFilename,
} from '../main/export-targets.js';
import type { PersistedExportTarget } from '../main/settings.js';

describe('desktop export targets', () => {
  const downloads = path.resolve('tmp', 'Downloads');
  const pdfTarget = path.resolve('tmp', 'Exports', 'Quarterly Review.pdf');
  const stored: PersistedExportTarget = {
    last: { path: pdfTarget, bookmark: 'bookmark-pdf' },
    byExtension: {
      pdf: { path: pdfTarget, bookmark: 'bookmark-pdf' },
    },
  };

  it('uses only a safe basename from a suggested document path', () => {
    expect(sanitizeExportFilename('/notes/planning:2026?.pdf')).to.equal('planning-2026-.pdf');
  });

  it('restores the last filename for the same document and extension', () => {
    expect(resolveExportTarget(downloads, stored, 'planning.pdf')).to.equal(pdfTarget);
  });

  it('keeps the last directory while deriving a filename for a new format', () => {
    expect(resolveExportTarget(downloads, stored, 'planning.docx')).to.equal(
      path.join(path.dirname(pdfTarget), 'planning.docx'),
    );
  });

  it('defaults a document without export history into Downloads', () => {
    expect(resolveExportTarget(downloads, undefined, '/notes/planning.pdf')).to.equal(
      path.join(downloads, 'planning.pdf'),
    );
  });

  it('treats a typed filename as relative to the displayed target directory', () => {
    expect(resolveRequestedExportTarget(pdfTarget, 'Board Review.pdf')).to.equal(
      path.join(path.dirname(pdfTarget), 'Board Review.pdf'),
    );
  });

  it('recognizes exact remembered targets and sibling filenames', () => {
    expect(findExportTargetAccess(stored, pdfTarget)?.bookmark).to.equal('bookmark-pdf');
    expect(
      isInRememberedExportDirectory(stored, path.join(path.dirname(pdfTarget), 'Summary.pdf')),
    ).to.equal(true);
    expect(isInRememberedExportDirectory(stored, path.join(downloads, 'Summary.pdf'))).to.equal(
      false,
    );
  });

  it('allows a textbox target directly inside the default Downloads directory', () => {
    expect(isInExportDirectory(downloads, path.join(downloads, 'Board Review.docx'))).to.equal(
      true,
    );
    expect(
      isInExportDirectory(downloads, path.join(downloads, 'nested', 'Board Review.docx')),
    ).to.equal(false);
  });
});
