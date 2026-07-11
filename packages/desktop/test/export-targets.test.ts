import { expect } from 'chai';
import path from 'node:path';

import {
  findExportTargetAccess,
  resolveExportTarget,
  sanitizeExportFilename,
} from '../main/export-targets.js';
import type { PersistedExportTarget } from '../main/settings.js';

describe('desktop export targets', () => {
  const downloads = path.resolve('tmp', 'Downloads');
  const pdfTarget = path.resolve('tmp', 'Exports', 'Quarterly Review.pdf');
  const stored: PersistedExportTarget = {
    last: { path: pdfTarget, bookmark: 'bookmark-pdf', confirmedByPicker: true },
    byExtension: {
      pdf: { path: pdfTarget, bookmark: 'bookmark-pdf', confirmedByPicker: true },
    },
  };

  it('uses only a safe basename from a suggested document path', () => {
    expect(sanitizeExportFilename('/notes/planning:2026?.pdf')).to.equal('planning-2026-.pdf');
  });

  it('restores the last filename for the same document and extension', () => {
    expect(resolveExportTarget(downloads, stored, 'planning.pdf')).to.equal(pdfTarget);
  });

  it('does not widen an exact grant to sibling files for a new format', () => {
    expect(resolveExportTarget(downloads, stored, 'planning.docx')).to.equal(
      path.join(downloads, 'planning.docx'),
    );
  });

  it('defaults a document without export history into Downloads', () => {
    expect(resolveExportTarget(downloads, undefined, '/notes/planning.pdf')).to.equal(
      path.join(downloads, 'planning.pdf'),
    );
  });

  it('does not trust legacy targets that were never confirmed by the native picker', () => {
    const legacy = { last: { path: pdfTarget }, byExtension: { pdf: { path: pdfTarget } } };
    expect(resolveExportTarget(downloads, legacy, 'planning.pdf')).to.equal(
      path.join(downloads, 'planning.pdf'),
    );
    expect(findExportTargetAccess(legacy, pdfTarget)).to.equal(null);
  });

  it('recognizes only exact remembered targets', () => {
    expect(findExportTargetAccess(stored, pdfTarget)?.bookmark).to.equal('bookmark-pdf');
    expect(
      findExportTargetAccess(stored, path.join(path.dirname(pdfTarget), 'Summary.pdf')),
    ).to.equal(null);
  });
});
