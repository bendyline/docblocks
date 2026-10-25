import { expect } from 'chai';

import { PdfReplacementsError } from '../src/Export/export-errors.js';
import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';
import { runExport } from '../src/Export/run-export.js';

/**
 * A converter's substitution warning must prevent both browser downloads and
 * destination writes. Other formats remain available with the original text.
 */
async function exportAs(markdown: string, format: 'pdf' | 'docx') {
  const saved: Blob[] = [];
  const result = await runExport(
    markdown,
    '/notes.md',
    { ...DEFAULT_OPTIONS, format },
    null,
    (blob) => {
      saved.push(blob);
    },
    // No diagrams here; keep the browser renderer out of the test.
    { diagramRenderer: async () => null },
  );
  expect(saved, `${format} saved a file`).to.have.length(1);
  return result;
}

describe('export warnings', function () {
  // The first export loads the PDF converter cold.
  this.timeout(30_000);

  it('refuses a lossy Japanese PDF before saving anything', async () => {
    const saved: Blob[] = [];
    let failure: unknown;
    try {
      await runExport(
        '# Notes\n\n日本語のテキスト\n',
        '/notes.md',
        { ...DEFAULT_OPTIONS, format: 'pdf' },
        null,
        (blob) => {
          saved.push(blob);
        },
        { diagramRenderer: async () => null },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(PdfReplacementsError);
    expect((failure as Error).message)
      .to.include('PDF was not saved')
      .and.include('Save it with the replacements')
      .and.include('Word, HTML, or EPUB');
    expect(saved).to.have.length(0);
  });

  it('saves the PDF with replacements when the user asks, and says what was replaced', async () => {
    const saved: Blob[] = [];
    const result = await runExport(
      '# Notes\n\n日本語のテキスト\n',
      '/notes.md',
      { ...DEFAULT_OPTIONS, format: 'pdf' },
      null,
      (blob) => {
        saved.push(blob);
      },
      { diagramRenderer: async () => null },
      { allowPdfReplacements: true },
    );
    expect(saved).to.have.length(1);
    expect(saved[0]!.type).to.equal('application/pdf');
    expect(result.warnings).to.have.length(1);
    expect(result.warnings[0]).to.include('character(s)');
  });

  it('reports nothing when the PDF kept every character', async () => {
    const result = await exportAs('# Notes\n\nZażółć — Ελληνικά — Привет мир.\n', 'pdf');
    expect(result.warnings).to.deep.equal([]);
  });

  it('reports nothing for formats that keep Unicode text', async () => {
    const result = await exportAs('# Notes\n\nПривет мир — 你好世界\n', 'docx');
    expect(result.warnings).to.deep.equal([]);
  });
});
