import { expect } from 'chai';
import { getPartBinary, openPackage } from '@bendyline/squisq-formats/ooxml';
import type { DiagramRasterizer, ExportDiagram } from '@bendyline/squisq-formats/diagrams';

import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';
import { runExport } from '../src/Export/run-export.js';

/**
 * Word, EPUB, PDF and PowerPoint exports carry diagrams as pictures. Drawing
 * needs a real browser canvas (covered by Squisq's export e2e), so these
 * tests stand in a renderer and check what reaches each file.
 */

/** A valid 1×1 PNG. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  ),
  (char) => char.charCodeAt(0),
);

const SOURCE = [
  '# Release',
  '',
  '```mermaid',
  'flowchart LR',
  '  accTitle: Release flow',
  '  a[Draft] --> b[Publish]',
  '```',
  '',
  '## Team {[drawing]}',
  '',
  '### Lead {#lead} {[rectangle x=0 y=0 width=200 height=90]}',
  '',
  '### Engineer {#engineer} {[rectangle x=0 y=200 width=200 height=90]}',
  '',
  '## After',
  '',
  'Closing paragraph.',
  '',
].join('\n');

async function exportAs(
  format: 'docx' | 'pdf' | 'epub' | 'pptx',
  diagramRenderer: DiagramRasterizer,
): Promise<ArrayBuffer> {
  const saved: Blob[] = [];
  await runExport(
    SOURCE,
    '/release.md',
    { ...DEFAULT_OPTIONS, format },
    null,
    (blob) => {
      saved.push(blob);
    },
    { diagramRenderer },
  );
  const blob = saved[0];
  if (!blob) throw new Error(`The ${format} export saved nothing`);
  return blob.arrayBuffer();
}

function recordingRenderer(): { render: DiagramRasterizer; seen: ExportDiagram[] } {
  const seen: ExportDiagram[] = [];
  return {
    seen,
    render: async (diagram) => {
      seen.push(diagram);
      return { data: PNG, width: 300, height: 150 };
    },
  };
}

async function documentXml(pkg: Awaited<ReturnType<typeof openPackage>>): Promise<string> {
  const bytes = await getPartBinary(pkg, 'word/document.xml');
  return bytes ? new TextDecoder().decode(bytes) : '';
}

function zipNames(bytes: ArrayBuffer): string {
  return new TextDecoder('latin1').decode(new Uint8Array(bytes));
}

describe('diagram pictures in exports', () => {
  it('Word gets a picture of each diagram, with alt text, not its source', async () => {
    const { render, seen } = recordingRenderer();
    const pkg = await openPackage(await exportAs('docx', render));
    expect(seen.map((diagram) => diagram.kind)).to.deep.equal(['mermaid', 'container']);
    expect(await getPartBinary(pkg, 'word/media/image1.png')).not.to.equal(null);
    expect(await getPartBinary(pkg, 'word/media/image2.png')).not.to.equal(null);
    const xml = await documentXml(pkg);
    expect(xml).not.to.contain('flowchart LR');
    expect(xml).to.contain('descr="Release flow"');
    // The drawing's heading stays; its shapes are in the picture.
    expect(xml).to.contain('Team');
    expect(xml).not.to.contain('Engineer');
    expect(xml).to.contain('Closing paragraph.');
  });

  it('PDF embeds the pictures', async () => {
    const text = zipNames(await exportAs('pdf', recordingRenderer().render));
    // Each PNG is an image plus, when it has transparency, a soft-mask image.
    expect(text.match(/\/Subtype\s*\/Image/gu)?.length ?? 0).to.be.at.least(2);
  });

  it('EPUB packages the pictures', async () => {
    const names = zipNames(await exportAs('epub', recordingRenderer().render));
    expect(names).to.contain('OEBPS/images/docblocks-diagram-1.png');
    expect(names).to.contain('OEBPS/images/docblocks-diagram-2.png');
  });

  it('PowerPoint pictures only Mermaid; the drawing stays native shapes', async () => {
    const { render, seen } = recordingRenderer();
    const bytes = await exportAs('pptx', render);
    expect(seen.map((diagram) => diagram.kind)).to.deep.equal(['mermaid']);
    expect(zipNames(bytes)).to.match(/ppt\/media\/image_s\d+_1\.png/u);
  });

  it('keeps a diagram as source, and still exports, when drawing fails', async () => {
    const pkg = await openPackage(
      await exportAs('docx', async () => {
        throw new Error('no canvas');
      }),
    );
    const xml = await documentXml(pkg);
    expect(xml).to.contain('flowchart LR');
    expect(await getPartBinary(pkg, 'word/media/image1.png')).to.equal(null);
  });
});
