import { expect } from 'chai';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import type { ContentContainer } from '@bendyline/squisq/storage';
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

/** A small, valid SVG: what an island fence or an attached .svg holds. */
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60">' +
  '<rect width="120" height="60" fill="#c33"/></svg>';

const SVG_ISLAND_SOURCE = ['# Logo', '', '```svg', SVG, '```', '', 'After the logo.', ''].join(
  '\n',
);

const SVG_ATTACHMENT_SOURCE = ['# Logo', '', '![Company logo](logo.svg)', '', 'After.', ''].join(
  '\n',
);

async function exportAs(
  format: 'docx' | 'pdf' | 'epub' | 'pptx' | 'html',
  diagramRenderer: DiagramRasterizer,
  source = SOURCE,
  mediaContainer: ContentContainer | null = null,
): Promise<ArrayBuffer> {
  const saved: Blob[] = [];
  await runExport(
    source,
    '/release.md',
    { ...DEFAULT_OPTIONS, format },
    mediaContainer,
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

/**
 * Whether one of the package's `folder` PNGs is the stand-in renderer's
 * picture, rather than the stand-in an exporter generates on its own.
 */
async function storesRendererPng(bytes: ArrayBuffer, folder: string): Promise<boolean> {
  const pkg = await openPackage(bytes);
  const pattern = new RegExp(`${folder}/[^/\\s"]+?\\.png`, 'gu');
  for (const name of new Set(zipNames(bytes).match(pattern) ?? [])) {
    const part = await getPartBinary(pkg, name);
    const data = part ? new Uint8Array(part) : null;
    if (data && data.length === PNG.length && data.every((byte, i) => byte === PNG[i])) {
      return true;
    }
  }
  return false;
}

/** A container holding `logo.svg`, as an attached SVG image. */
async function logoContainer(): Promise<ContentContainer> {
  const container = new MemoryContentContainer();
  await container.writeFile('logo.svg', new TextEncoder().encode(SVG));
  return container;
}

describe('SVG pictures in exports', () => {
  it('Word keeps an SVG island as vector art and stores its picture as the fallback', async () => {
    const { render, seen } = recordingRenderer();
    const bytes = await exportAs('docx', render, SVG_ISLAND_SOURCE);
    // Asked once, for the fallback only; the island is not swapped for a picture.
    expect(seen.map((diagram) => diagram.kind)).to.deep.equal(['svg']);
    expect(zipNames(bytes)).to.match(/word\/media\/[^/\s"]+\.svg/u);
    expect(await storesRendererPng(bytes, 'word/media')).to.equal(true);
    const xml = await documentXml(await openPackage(bytes));
    expect(xml).not.to.contain('viewBox');
    expect(xml).to.contain('After the logo.');
  });

  it('PDF draws an SVG island as its picture', async () => {
    const { render, seen } = recordingRenderer();
    const text = zipNames(await exportAs('pdf', render, SVG_ISLAND_SOURCE));
    expect(seen.map((diagram) => diagram.kind)).to.deep.equal(['svg']);
    expect(text.match(/\/Subtype\s*\/Image/gu)?.length ?? 0).to.be.at.least(1);
  });

  it('PowerPoint stores the picture beside an SVG island', async () => {
    const { render, seen } = recordingRenderer();
    const bytes = await exportAs('pptx', render, SVG_ISLAND_SOURCE);
    expect(seen.map((diagram) => diagram.kind)).to.deep.equal(['svg']);
    expect(await storesRendererPng(bytes, 'ppt/media')).to.equal(true);
  });

  it('PDF swaps an attached SVG for its picture', async () => {
    const { render, seen } = recordingRenderer();
    const text = zipNames(
      await exportAs('pdf', render, SVG_ATTACHMENT_SOURCE, await logoContainer()),
    );
    expect(seen).to.have.length(1);
    expect(seen[0]?.kind).to.equal('svg');
    expect(seen[0]?.source).to.equal(SVG);
    expect(text.match(/\/Subtype\s*\/Image/gu)?.length ?? 0).to.be.at.least(1);
  });

  it('Word stores a picture of an attached SVG as its fallback', async () => {
    const { render, seen } = recordingRenderer();
    const bytes = await exportAs('docx', render, SVG_ATTACHMENT_SOURCE, await logoContainer());
    expect(seen.map((diagram) => diagram.source)).to.deep.equal([SVG]);
    expect(zipNames(bytes)).to.match(/word\/media\/[^/\s"]+\.svg/u);
    expect(await storesRendererPng(bytes, 'word/media')).to.equal(true);
  });

  it('still exports an SVG island when drawing it fails', async () => {
    const bytes = await exportAs(
      'pdf',
      async () => {
        throw new Error('no canvas');
      },
      SVG_ISLAND_SOURCE,
    );
    expect(bytes.byteLength).to.be.greaterThan(0);
  });

  it('a plain Web page gets pictures of diagrams and charts, a data table, and SVG icons', async () => {
    const { render, seen } = recordingRenderer();
    const container = new MemoryContentContainer();
    await container.writeFile(
      'data/sales.csv',
      Uint8Array.from('Region,Revenue\nNorth,120\nSouth,90\n', (c) => c.charCodeAt(0)),
    );
    const source = [
      SOURCE,
      '## Revenue {[barChart src=data/sales.csv]}',
      '',
      '## Ledger {[dataTable src=data/sales.csv]}',
      '',
      '## Reviews',
      '',
      'Rated {[fa-solid:star]} by readers {[statHighlight]}',
      '',
    ].join('\n');
    const html = new TextDecoder().decode(await exportAs('html', render, source, container));
    expect(seen.map((diagram) => diagram.kind)).to.deep.equal(['mermaid', 'container', 'chart']);
    expect(html.match(/<img src="data:image\/png;base64,/g)).to.have.length(3);
    expect(html).not.to.contain('flowchart LR');
    expect(html).to.contain('<td>North</td><td>120</td>');
    expect(html).to.contain('<svg class="squisq-icon"');
    expect(html).not.to.contain('{[');
  });
});
