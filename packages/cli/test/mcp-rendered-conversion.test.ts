import { expect } from 'chai';
import JSZip from 'jszip';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import { DocumentService } from '../src/mcp/document-service.js';
import {
  convertRenderedDocument,
  packageRenderedPdf,
  packageRenderedPptx,
  prepareRenderedDocument,
  type RenderedFrameCapture,
} from '../src/mcp/rendered-conversion.js';
import type { CapturedPreview } from '../src/mcp/preview-service.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const ALTERNATE_ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);

function frame(index: number, width = 1_200, height = 900): CapturedPreview {
  return {
    bytes: ONE_PIXEL_PNG,
    index,
    label: `Visual ${index + 1}`,
    width,
    height,
  };
}

async function withoutHarnessDomParser<T>(operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  Object.defineProperty(globalThis, 'DOMParser', {
    configurable: true,
    value: undefined,
    writable: true,
  });
  try {
    return await operation();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'DOMParser', descriptor);
    else Reflect.deleteProperty(globalThis, 'DOMParser');
  }
}

describe('MCP rendered-fidelity packaging', () => {
  it('normalizes theme, transform, templates, title, custom themes, and media before capture', async () => {
    const artifacts = new ArtifactStore();
    try {
      const [{ compileTheme }, { writeCustomThemesToFrontmatter }] = await Promise.all([
        import('@bendyline/squisq/schemas'),
        import('@bendyline/squisq/doc'),
      ]);
      const customTheme = compileTheme({
        id: 'render-brand',
        name: 'Render Brand',
        seedColors: { primary: '#2457c5', secondary: '#df5b38' },
      });
      const encodedTheme = writeCustomThemesToFrontmatter([customTheme]);
      const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
      const prepared = await documents.prepare({
        kind: 'markdown',
        name: 'pipeline.md',
        markdown: `---
squisq-theme: documentary
squisq-custom-themes: ${encodedTheme}
---

# Original title

## Quarterly performance

Revenue increased by eighteen percent while operating costs declined by seven percent.

| Metric | Value |
| --- | ---: |
| Revenue | 118 |
| Cost | 93 |
`,
      });
      await prepared.container.writeFile(
        'media/brand.png',
        new Uint8Array(ALTERNATE_ONE_PIXEL_PNG),
        'image/png',
      );

      const baseline = await prepareRenderedDocument(prepared, { autoTemplates: false });
      const styled = await prepareRenderedDocument(prepared, {
        themeId: 'render-brand',
        transformId: 'data-driven',
        autoTemplates: true,
        title: 'Agent-authored title',
      });

      expect(styled.prepared.doc.themeId).to.equal('render-brand');
      expect(styled.prepared.doc.startBlock?.title).to.equal('Agent-authored title');
      expect(styled.prepared.doc.customThemes?.map(({ id }) => id)).to.include('render-brand');
      expect(styled.prepared.markdown).to.include('title: Agent-authored title');
      expect(styled.prepared.markdown).to.include('squisq-theme: render-brand');
      expect(JSON.stringify(styled.prepared.doc.blocks)).to.not.equal(
        JSON.stringify(baseline.prepared.doc.blocks),
      );
      expect(
        Buffer.from((await styled.prepared.container.readFile('media/brand.png')) ?? []),
      ).to.deep.equal(ALTERNATE_ONE_PIXEL_PNG);
    } finally {
      await artifacts.dispose();
    }
  });

  it('feeds applied theme and transform state into the rendered package output', async () => {
    const artifacts = new ArtifactStore();
    try {
      const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
      const prepared = await documents.prepare({
        kind: 'markdown',
        name: 'rendered.md',
        markdown:
          '# Original\n\n## Results\n\nRevenue grew by eighteen percent across all major regions this quarter.',
      });
      const capturedDocs: string[] = [];
      const capture: RenderedFrameCapture = async (rendered) => {
        capturedDocs.push(JSON.stringify(rendered.doc));
        const themed = rendered.doc.themeId === 'cinematic';
        return [
          {
            ...frame(0),
            bytes: themed ? ALTERNATE_ONE_PIXEL_PNG : ONE_PIXEL_PNG,
          },
        ];
      };
      const baseline = await convertRenderedDocument(
        prepared,
        'pptx',
        'rendered-fidelity',
        {},
        {},
        undefined,
        undefined,
        capture,
      );
      const styled = await convertRenderedDocument(
        prepared,
        'pptx',
        'rendered-fidelity',
        {},
        {
          themeId: 'cinematic',
          transformId: 'magazine',
          autoTemplates: true,
          title: 'Rendered pipeline title',
        },
        undefined,
        undefined,
        capture,
      );
      const baselineZip = await JSZip.loadAsync(baseline.bytes);
      const styledZip = await JSZip.loadAsync(styled.bytes);
      const baselineImage = await baselineZip.file('ppt/media/rendered1.png')?.async('nodebuffer');
      const styledImage = await styledZip.file('ppt/media/rendered1.png')?.async('nodebuffer');
      const coreProperties = await styledZip.file('docProps/core.xml')?.async('string');

      expect(capturedDocs).to.have.length(2);
      expect(capturedDocs[1]).to.include('"themeId":"cinematic"');
      expect(capturedDocs[1]).to.not.equal(capturedDocs[0]);
      expect(baselineImage).to.deep.equal(ONE_PIXEL_PNG);
      expect(styledImage).to.deep.equal(ALTERNATE_ONE_PIXEL_PNG);
      expect(coreProperties).to.include('Rendered pipeline title');
    } finally {
      await artifacts.dispose();
    }
  });

  it('creates a full-slide image PPTX with hidden hybrid semantic text', async () => {
    const bytes = await packageRenderedPptx(
      [frame(0), frame(1)],
      ['First semantic body', 'Second semantic body'],
      true,
    );
    const archive = await JSZip.loadAsync(bytes);
    const firstSlide = await archive.file('ppt/slides/slide1.xml')?.async('string');
    const firstRelationships = await archive
      .file('ppt/slides/_rels/slide1.xml.rels')
      ?.async('string');
    const firstImage = await archive.file('ppt/media/rendered1.png')?.async('nodebuffer');

    expect(archive.file(/^ppt\/slides\/slide\d+\.xml$/u)).to.have.length(2);
    expect(firstSlide).to.contain('First semantic body');
    expect(firstSlide).to.contain('hidden="1"');
    expect(firstSlide).to.contain('r:embed="rId2"');
    expect(firstRelationships).to.contain('../media/rendered1.png');
    expect(firstImage).to.deep.equal(ONE_PIXEL_PNG);
  });

  it('strips XML-invalid control characters from PPTX slide parts without mangling text', async () => {
    // XML 1.0 forbids most C0 controls outright (Char production) — they cannot
    // be escaped as numeric entities, so a raw one makes the slide part
    // unparseable and PowerPoint reports "presentation needs repair". These
    // reach the emitter from real documents: squisq's parser preserves C0
    // controls in `plainText`, which feeds `semanticText`, and `frame.label`
    // is interpolated into the image `descr` attribute.
    const control = (code: number): string => String.fromCharCode(code);
    const VT = control(0x0b);
    const FF = control(0x0c);
    const BEL = control(0x07);
    const NUL = control(0x00);

    const labelled: CapturedPreview = {
      ...frame(0),
      label: `Label ${VT} with café 中文 \u{1F600}`,
    };
    const bytes = await packageRenderedPptx(
      [labelled],
      [`Body ${FF} and ${BEL} and ${NUL} plus\ttab & <amp>`],
      true,
    );
    const archive = await JSZip.loadAsync(bytes);
    const slide = await archive.file('ppt/slides/slide1.xml')?.async('string');
    expect(slide).to.be.a('string');
    const xml = slide as string;

    // No XML-1.0-invalid character survives, in the attribute or the text node.
    for (const code of [0x00, 0x07, 0x0b, 0x0c, 0x01, 0x1f]) {
      expect(xml, `control char 0x${code.toString(16)} reached the slide XML`).not.to.contain(
        control(code),
      );
    }

    // Legitimate text must not be collateral damage: tab is valid in XML 1.0,
    // and accents / CJK / astral characters are ordinary content.
    expect(xml).to.contain('plus\ttab');
    expect(xml).to.contain('café 中文 \u{1F600}');
    // Ordinary escaping still applies.
    expect(xml).to.contain('&amp; &lt;amp&gt;');
  });

  it('matches PPTX slide and image geometry to wide and portrait capture aspect ratios', async () => {
    for (const dimensions of [
      { width: 1_920, height: 1_080, expectedWidth: 12_192_000, expectedHeight: 6_858_000 },
      { width: 1_080, height: 1_920, expectedWidth: 6_858_000, expectedHeight: 12_192_000 },
    ]) {
      const bytes = await packageRenderedPptx(
        [frame(0, dimensions.width, dimensions.height)],
        ['semantic body'],
        false,
      );
      const archive = await JSZip.loadAsync(bytes);
      const presentation = await archive.file('ppt/presentation.xml')?.async('string');
      const slide = await archive.file('ppt/slides/slide1.xml')?.async('string');

      expect(presentation).to.include(
        `<p:sldSz cx="${dimensions.expectedWidth}" cy="${dimensions.expectedHeight}" type="custom"/>`,
      );
      expect(slide).to.include(
        `<a:off x="0" y="0"/><a:ext cx="${dimensions.expectedWidth}" cy="${dimensions.expectedHeight}"/>`,
      );
    }
  });

  it('creates a multi-page hybrid PDF with attached Markdown source', async () => {
    const bytes = await packageRenderedPdf(
      [frame(0), frame(1)],
      ['First semantic body', 'Second semantic body'],
      '# Editable source',
      'hybrid',
    );
    expect(Buffer.from(bytes.subarray(0, 5)).toString('ascii')).to.equal('%PDF-');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).to.equal(2);
    expect(pdf.getTitle()).to.equal('hybrid');
    const names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict);
    const embeddedFiles = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
    const embeddedNames = embeddedFiles.lookup(PDFName.of('Names'), PDFArray);
    expect(embeddedNames.lookup(0, PDFHexString).decodeText()).to.equal('hybrid.md');
  });

  it('reopens rendered PPTX and PDF output through the linked Squisq import APIs', async () => {
    const [pptxBytes, pdfBytes, { pptxToContainer }, { pdfToContainer }] = await Promise.all([
      packageRenderedPptx([frame(0)], ['Independent PPTX semantic body'], true),
      packageRenderedPdf(
        [frame(0)],
        ['Independent PDF semantic body'],
        '# Editable source',
        'independent',
      ),
      import('@bendyline/squisq-formats/pptx'),
      import('@bendyline/squisq-formats/pdf'),
    ]);

    const pptx = await withoutHarnessDomParser(() =>
      pptxToContainer(Uint8Array.from(pptxBytes).buffer, {
        inferLayouts: false,
        inferTheme: false,
      }),
    );
    const pptxMarkdown = await pptx.readDocument();
    const pptxImages = await pptx.listFiles('images/');
    expect(pptxMarkdown).to.include('Independent PPTX semantic body');
    expect(pptxImages).to.have.length(1);
    expect(pptxImages[0]?.mimeType).to.equal('image/png');
    expect(Buffer.from((await pptx.readFile(pptxImages[0]!.path)) ?? [])).to.deep.equal(
      ONE_PIXEL_PNG,
    );

    const pdf = await pdfToContainer(pdfBytes);
    const pdfMarkdown = await pdf.readDocument();
    expect(pdfMarkdown).to.include('Independent PDF semantic body');
  });

  it('stops PPTX serialization when cancellation arrives from JSZip progress', async () => {
    const controller = new AbortController();
    const reason = new Error('stop PPTX serialization');
    let progressCalls = 0;

    try {
      await packageRenderedPptx(
        [frame(0), frame(1)],
        ['First semantic body', 'Second semantic body'],
        true,
        controller.signal,
        undefined,
        {
          onPptxSerializationProgress() {
            progressCalls += 1;
            controller.abort(reason);
          },
        },
      );
      expect.fail('Expected cancellation during PPTX serialization');
    } catch (caught: unknown) {
      expect(caught).to.equal(reason);
    }

    expect(progressCalls).to.equal(1);
  });

  it('stops PDF serialization when cancellation arrives between serialized objects', async () => {
    const controller = new AbortController();
    const reason = new Error('stop PDF serialization');
    let progressCalls = 0;

    try {
      await packageRenderedPdf(
        [frame(0), frame(1)],
        ['First semantic body', 'Second semantic body'],
        '# Editable source',
        'cancelled',
        controller.signal,
        undefined,
        {
          onPdfSerializationProgress() {
            progressCalls += 1;
            controller.abort(reason);
          },
        },
      );
      expect.fail('Expected cancellation during PDF serialization');
    } catch (caught: unknown) {
      expect(caught).to.equal(reason);
    }

    expect(progressCalls).to.equal(1);
  });

  it('honors cancellation before publishing a rendered package', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop rendering'));
    try {
      await packageRenderedPptx([frame(0)], ['text'], false, controller.signal);
      expect.fail('Expected cancellation');
    } catch (caught: unknown) {
      expect(String(caught)).to.contain('stop rendering');
    }
  });
});
