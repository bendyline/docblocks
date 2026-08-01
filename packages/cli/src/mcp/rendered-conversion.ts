import JSZip from 'jszip';
import type { ConversionFidelity } from '@bendyline/docblocks/mcp';
import type { FormatDefinition, NormalizedInput } from '@bendyline/squisq-cli/api';
import type { PreparedDocument } from './document-service.js';
import { analyzeDocumentBlocks } from './block-analysis.js';
import { throwIfAborted } from './document-service.js';
import {
  capturePreparedDocumentFrames,
  type CapturedPreview,
  type PreviewProgress,
} from './preview-service.js';

const PPTX_REFERENCE_SHORT_EDGE_EMU = 6_858_000;
const MAX_HYBRID_TEXT_CHARACTERS = 8_000;

export interface RenderedConversionResult {
  bytes: Uint8Array;
  mimeType: string;
  suggestedFilename: string;
  warnings: string[];
}

export interface RenderedDocumentOptions {
  themeId?: string;
  transformId?: string;
  autoTemplates?: boolean;
  title?: string;
}

export type RenderedFrameCapture = (
  prepared: PreparedDocument,
  options: { width?: number; height?: number },
  signal?: AbortSignal,
  progress?: PreviewProgress,
) => Promise<CapturedPreview[]>;

export interface PreparedRenderedDocument {
  prepared: PreparedDocument;
  warnings: readonly string[];
}

export interface RenderedSerializationHooks {
  onPptxSerializationProgress?: (percent: number) => void;
  onPdfSerializationProgress?: (processedObjects: number) => void;
}

/** Produce image-backed PPTX/PDF output from the actual linked Squisq player. */
export async function convertRenderedDocument(
  prepared: PreparedDocument,
  format: string,
  fidelity: ConversionFidelity,
  options: Readonly<Record<string, string | number | boolean | null>>,
  documentOptions: RenderedDocumentOptions,
  signal?: AbortSignal,
  progress?: PreviewProgress,
  capture: RenderedFrameCapture = capturePreparedDocumentFrames,
): Promise<RenderedConversionResult> {
  if (format !== 'pptx' && format !== 'pdf') {
    throw new Error(`${fidelity} conversion is available only for PPTX and PDF`);
  }
  const width = numericOption(options, 'width', 1_200);
  const height = numericOption(options, 'height', 900);
  const normalized = await prepareRenderedDocument(prepared, documentOptions, signal);
  const rendered = normalized.prepared;
  const frames = await capture(rendered, { width, height }, signal, progress);
  if (frames.length === 0) throw new Error('Rendered-fidelity conversion requires visual content');
  throwIfAborted(signal);
  const semanticText = await semanticTextByFrame(rendered, frames);
  if (format === 'pptx') {
    return {
      bytes: await packageRenderedPptx(
        frames,
        semanticText,
        fidelity === 'hybrid',
        signal,
        documentOptions.title,
      ),
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      suggestedFilename: `${prepared.baseName}.pptx`,
      warnings:
        fidelity === 'hybrid'
          ? [
              ...normalized.warnings,
              'Hybrid PPTX stores each Squisq visual as a full-slide image and retains hidden semantic text for editing and extraction.',
            ]
          : [
              ...normalized.warnings,
              'Rendered-fidelity PPTX preserves Squisq pixels; slide contents are images rather than native editable shapes.',
            ],
    };
  }
  return {
    bytes: await packageRenderedPdf(
      frames,
      semanticText,
      fidelity === 'hybrid' ? rendered.markdown : null,
      prepared.baseName,
      signal,
      documentOptions.title,
    ),
    mimeType: 'application/pdf',
    suggestedFilename: `${prepared.baseName}.pdf`,
    warnings:
      fidelity === 'hybrid'
        ? [
            ...normalized.warnings,
            'Hybrid PDF retains invisible extraction text and an attached Markdown source, but is not a fully tagged accessible PDF.',
          ]
        : [
            ...normalized.warnings,
            'Rendered-fidelity PDF preserves Squisq pixels; page contents are raster images and are not editable.',
          ],
  };
}

/** Apply linked-registry normalization and transforms before the visual renderer sees the Doc. */
export async function prepareRenderedDocument(
  prepared: PreparedDocument,
  options: RenderedDocumentOptions,
  signal?: AbortSignal,
): Promise<PreparedRenderedDocument> {
  throwIfAborted(signal);
  const { convert, createCliRegistry } = await import('@bendyline/squisq-cli/api');
  const registry = createCliRegistry();
  const captureFormat = 'docblocks-render-input';
  let normalized: NormalizedInput | undefined;
  const captureDefinition: FormatDefinition = {
    id: captureFormat,
    label: 'DocBlocks rendered input',
    mimeType: 'application/x-docblocks-render-input',
    extensions: ['.render-input'],
    async exportDoc(input) {
      normalized = input;
      return {
        bytes: new Uint8Array(0),
        mimeType: 'application/x-docblocks-render-input',
        suggestedFilename: 'render-input',
        warnings: [],
      };
    },
  };
  registry.register(captureDefinition);
  const canonicalMarkdown =
    options.autoTemplates === true
      ? prepared.markdownDoc
      : (await import('@bendyline/squisq/doc')).docToMarkdown(prepared.doc, {
          defaultTemplate: 'sectionHeader',
        });
  const result = await convert(
    {
      kind: 'markdown',
      markdown: canonicalMarkdown,
      container: prepared.container,
      baseName: prepared.baseName,
    },
    captureFormat,
    {
      registry,
      themeId: options.themeId,
      transformStyle: options.transformId,
      autoTemplates: options.autoTemplates,
      title: options.title,
      signal,
    },
  );
  throwIfAborted(signal);
  if (!normalized) throw new Error('Linked Squisq did not produce a rendered document input');

  const { docToMarkdown } = await import('@bendyline/squisq/doc');
  const { stringifyMarkdown } = await import('@bendyline/squisq/markdown');
  let markdownDoc = normalized.markdownDoc ?? docToMarkdown(normalized.doc);
  let doc = normalized.doc;
  if (options.title !== undefined || options.themeId !== undefined) {
    const frontmatter = {
      ...(markdownDoc.frontmatter ?? {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.themeId !== undefined ? { 'squisq-theme': options.themeId } : {}),
    };
    markdownDoc = { ...markdownDoc, frontmatter };
    doc = {
      ...doc,
      frontmatter: { ...(doc.frontmatter ?? {}), ...frontmatter },
      ...(options.title !== undefined
        ? {
            startBlock: doc.startBlock
              ? { ...doc.startBlock, title: options.title }
              : { title: options.title },
          }
        : {}),
    };
  }
  if (options.themeId !== undefined && doc.themeId !== options.themeId) {
    doc = { ...doc, themeId: options.themeId };
  }

  return {
    prepared: {
      ...prepared,
      markdown: stringifyMarkdown(markdownDoc),
      markdownDoc,
      doc,
      container: normalized.container,
    },
    warnings: result.warnings,
  };
}

export async function packageRenderedPptx(
  frames: readonly CapturedPreview[],
  semanticText: readonly string[],
  hybrid: boolean,
  signal?: AbortSignal,
  title?: string,
  serializationHooks: RenderedSerializationHooks = {},
): Promise<Uint8Array> {
  const { convert } = await import('@bendyline/squisq-cli/api');
  const scaffold = frames
    .map((_frame, index) => `## Rendered slide ${index + 1}\n\nPlaceholder`)
    .join('\n\n');
  const converted = await convert(
    { kind: 'markdown', markdown: scaffold, baseName: 'rendered' },
    'pptx',
    {
      ...(title === undefined ? {} : { title }),
      signal,
      // The scaffold is a throwaway 1:1 frame->slide vehicle whose slides are
      // all overwritten below with captured images. Squisq's cover slide is on
      // by default; here it would prepend a slide built from the placeholder
      // text, shifting every frame by one and leaving the last scaffold slide
      // un-overwritten as a visible "Rendered slide N / Placeholder" page.
      formatOptions: { pptx: { includeCoverSlide: false } },
    },
  );
  throwIfAborted(signal);
  const archive = await JSZip.loadAsync(converted.bytes);
  const slideSize = renderedPptxSlideSize(frames[0]!);
  const presentationPart = archive.file('ppt/presentation.xml');
  if (!presentationPart) throw new Error('Linked PPTX scaffold has no presentation manifest');
  const presentation = await presentationPart.async('string');
  const resizedPresentation = presentation.replace(
    /<p:sldSz\b[^>]*\/>/u,
    `<p:sldSz cx="${slideSize.width}" cy="${slideSize.height}" type="custom"/>`,
  );
  if (resizedPresentation === presentation) {
    throw new Error('Linked PPTX scaffold has no slide-size declaration');
  }
  archive.file('ppt/presentation.xml', resizedPresentation);
  const contentTypesPart = archive.file('[Content_Types].xml');
  if (!contentTypesPart) throw new Error('Linked PPTX scaffold has no content-types manifest');
  let contentTypes = await contentTypesPart.async('string');
  if (!/Extension="png"/iu.test(contentTypes)) {
    contentTypes = contentTypes.replace(
      '</Types>',
      '<Default Extension="png" ContentType="image/png"/></Types>',
    );
    archive.file('[Content_Types].xml', contentTypes);
  }
  for (let index = 0; index < frames.length; index += 1) {
    throwIfAborted(signal);
    const frame = frames[index]!;
    const slideNumber = index + 1;
    archive.file(`ppt/media/rendered${slideNumber}.png`, frame.bytes);
    archive.file(
      `ppt/slides/slide${slideNumber}.xml`,
      renderedSlideXml(frame, semanticText[index] ?? '', hybrid, slideSize),
    );
    archive.file(
      `ppt/slides/_rels/slide${slideNumber}.xml.rels`,
      slideRelationshipsXml(slideNumber),
    );
  }
  return generatePptxArchive(archive, signal, serializationHooks.onPptxSerializationProgress);
}

export async function packageRenderedPdf(
  frames: readonly CapturedPreview[],
  semanticText: readonly string[],
  markdownAttachment: string | null,
  baseName: string,
  signal?: AbortSignal,
  title?: string,
  serializationHooks: RenderedSerializationHooks = {},
): Promise<Uint8Array> {
  const { PDFDocument, PDFWriter, StandardFonts } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(title ?? baseName);
  pdf.setProducer('DocBlocks rendered-fidelity pipeline');
  const invisibleFont = markdownAttachment ? await pdf.embedFont(StandardFonts.Helvetica) : null;
  for (let index = 0; index < frames.length; index += 1) {
    throwIfAborted(signal);
    const frame = frames[index]!;
    const image = await pdf.embedPng(frame.bytes);
    const pageWidth = 720;
    const pageHeight = pageWidth * (frame.height / frame.width);
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    if (invisibleFont) {
      page.drawText(asWinAnsiText(semanticText[index] ?? ''), {
        x: 1,
        y: 1,
        size: 1,
        font: invisibleFont,
        opacity: 0,
        lineHeight: 1,
        maxWidth: pageWidth - 2,
      });
    }
  }
  if (markdownAttachment !== null) {
    await pdf.attach(Buffer.from(markdownAttachment, 'utf8'), `${baseName}.md`, {
      mimeType: 'text/markdown',
      description: 'Editable semantic source for this rendered document',
      creationDate: new Date(),
      modificationDate: new Date(),
    });
  }
  throwIfAborted(signal);
  await pdf.flush();
  throwIfAborted(signal);

  let processedObjects = 0;
  class CancellablePdfWriter extends PDFWriter {
    public constructor() {
      super(pdf.context, 1);
    }

    protected override shouldWaitForTick = (count: number): boolean => {
      throwIfAborted(signal);
      processedObjects += count;
      serializationHooks.onPdfSerializationProgress?.(processedObjects);
      throwIfAborted(signal);
      return true;
    };
  }

  const bytes = await new CancellablePdfWriter().serializeToBuffer();
  throwIfAborted(signal);
  return bytes;
}

function generatePptxArchive(
  archive: JSZip,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const stream = archive.generateInternalStream({ type: 'uint8array', compression: 'DEFLATE' });

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let settled = false;

    const cleanup = (): void => signal?.removeEventListener('abort', handleAbort);
    const fail = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      stream.pause();
      cleanup();
      reject(reason);
    };
    const handleAbort = (): void => {
      try {
        throwIfAborted(signal);
      } catch (caught: unknown) {
        fail(caught);
      }
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }

    stream
      .on('data', (chunk, metadata) => {
        if (settled) return;
        try {
          throwIfAborted(signal);
          onProgress?.(metadata.percent);
          throwIfAborted(signal);
          chunks.push(chunk);
          byteLength += chunk.byteLength;
        } catch (caught: unknown) {
          fail(caught);
        }
      })
      .on('error', (error) => fail(error))
      .on('end', () => {
        if (settled) return;
        try {
          throwIfAborted(signal);
          const bytes = new Uint8Array(byteLength);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          settled = true;
          cleanup();
          resolve(bytes);
        } catch (caught: unknown) {
          fail(caught);
        }
      })
      .resume();
  });
}

async function semanticTextByFrame(
  prepared: PreparedDocument,
  frames: readonly CapturedPreview[],
): Promise<string[]> {
  const analyzed = await analyzeDocumentBlocks(prepared.doc.blocks);
  return frames.map((frame) => {
    const analyzedBlock = analyzed[frame.index];
    return `${frame.label ?? ''}\n${analyzedBlock?.plainText ?? ''}`
      .trim()
      .slice(0, MAX_HYBRID_TEXT_CHARACTERS);
  });
}

function renderedSlideXml(
  frame: CapturedPreview,
  semanticText: string,
  hybrid: boolean,
  slideSize: { width: number; height: number },
): string {
  const description = escapeXml(frame.label ?? `Rendered slide ${frame.index + 1}`);
  const placement = containedImagePlacement(frame, slideSize);
  const hiddenText = hybrid
    ? `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Semantic text" hidden="1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm><a:noFill/></p:spPr>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="100"/>` +
      `<a:t>${escapeXml(semanticText)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
    : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Rendered visual" descr="${description}"/>` +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    `<p:spPr><a:xfrm><a:off x="${placement.x}" y="${placement.y}"/><a:ext cx="${placement.width}" cy="${placement.height}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>' +
    `${hiddenText}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function renderedPptxSlideSize(frame: CapturedPreview): { width: number; height: number } {
  if (frame.width < 1 || frame.height < 1) {
    throw new Error('Rendered PPTX frame dimensions must be positive');
  }
  const aspect = frame.width / frame.height;
  return aspect >= 1
    ? {
        width: Math.round(PPTX_REFERENCE_SHORT_EDGE_EMU * aspect),
        height: PPTX_REFERENCE_SHORT_EDGE_EMU,
      }
    : {
        width: PPTX_REFERENCE_SHORT_EDGE_EMU,
        height: Math.round(PPTX_REFERENCE_SHORT_EDGE_EMU / aspect),
      };
}

function containedImagePlacement(
  frame: CapturedPreview,
  slideSize: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(slideSize.width / frame.width, slideSize.height / frame.height);
  const width = Math.round(frame.width * scale);
  const height = Math.round(frame.height * scale);
  return {
    x: Math.round((slideSize.width - width) / 2),
    y: Math.round((slideSize.height - height) / 2),
    width,
    height,
  };
}

function slideRelationshipsXml(slideNumber: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/rendered${slideNumber}.png"/>` +
    '</Relationships>'
  );
}

/**
 * Characters that XML 1.0 forbids outright, per the `Char` production:
 *
 *   Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 *
 * Unlike `&` or `<`, these cannot be rescued by escaping — a numeric entity
 * such as `&#xB;` is *itself* invalid — so removal is the only conforming
 * option. Tab, newline, and CR are explicitly legal and are preserved, as are
 * accents, CJK, and astral characters (the `u` flag keeps well-formed
 * surrogate pairs intact while dropping lone surrogates, which cannot be
 * encoded as UTF-8 at all).
 *
 * This mirrors the PDF path's `asWinAnsiText` in spirit — sanitize to what the
 * container can actually represent before emitting — but stays far narrower:
 * WinAnsi cannot encode non-Latin-1 text, whereas XML can, so only genuinely
 * illegal characters are dropped rather than everything outside ASCII.
 */
/* eslint-disable no-control-regex -- Matching control characters is this
   pattern's entire purpose; the rule exists to catch unintentional ones. */
const XML_INVALID_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu;
/* eslint-enable no-control-regex */

/**
 * Escape a value for XML text and attribute contexts.
 *
 * Control characters reach here from real documents: `frame.label` and the
 * hybrid path's `semanticText` both derive from authored markdown, and squisq's
 * parser preserves C0 controls in `plainText`. Emitting one raw produces a
 * slide part that strict XML parsers reject, which PowerPoint reports as
 * "presentation needs repair" — so strip them before escaping.
 */
function escapeXml(value: string): string {
  return value
    .replace(XML_INVALID_CHARACTERS, '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function numericOption(
  options: Readonly<Record<string, string | number | boolean | null>>,
  name: string,
  fallback: number,
): number {
  const value = options[name];
  return typeof value === 'number' ? value : fallback;
}

function asWinAnsiText(value: string): string {
  const sanitized = value.replace(/[^\x20-\x7e\r\n\t]/gu, '?').slice(0, MAX_HYBRID_TEXT_CHARACTERS);
  return sanitized || ' ';
}
