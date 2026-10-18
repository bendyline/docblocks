import { expect } from 'chai';

import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';
import { runExport } from '../src/Export/run-export.js';

/**
 * PDF export can only draw what its standard fonts encode; everything else is
 * replaced. That loss used to reach only the console, so `runExport` now
 * returns it for the export UI to show.
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

  it('reports the characters a PDF had to replace', async () => {
    const result = await exportAs('# Notes\n\nПривет мир — 你好世界\n', 'pdf');
    expect(result.warnings).to.have.length(1);
    expect(result.warnings[0]).to.match(/replaced \d+ character/u);
  });

  it('reports nothing when the PDF kept every character', async () => {
    const result = await exportAs('# Notes\n\nPlain “quoted” text — with an em dash.\n', 'pdf');
    expect(result.warnings).to.deep.equal([]);
  });

  it('reports nothing for formats that keep Unicode text', async () => {
    const result = await exportAs('# Notes\n\nПривет мир — 你好世界\n', 'docx');
    expect(result.warnings).to.deep.equal([]);
  });
});
