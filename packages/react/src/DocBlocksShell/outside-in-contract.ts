/**
 * Compatibility host for Squisq's outside-in contract.
 *
 * The canonical API is `@bendyline/squisq-formats/outside-in`. DocBlocks keeps
 * only the synchronous path layout (in core); metadata and conversion operations
 * load the canonical implementation on demand so format runtimes stay behind
 * the outside-in document boundary.
 */

import type { MarkdownDocument } from '@bendyline/squisq/markdown';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { ConversionResult, ConvertOptions } from '@bendyline/squisq-formats/registry';
import type { DiagramRasterizer } from '@bendyline/squisq-formats/diagrams';
import {
  resolveOutsideInLayout,
  type OutsideInFormatId,
  type OutsideInLayout,
} from '@bendyline/docblocks/workspace-settings';

// The synchronous path layout is shared with the workspace catalog walker
// and the VS Code extension host, so it lives in core.
export {
  OUTSIDE_IN_FORMAT_IDS,
  chooseOutsideInMarkdownPath,
  relocateOutsideInLayout,
  resolveOutsideInLayout,
  type OutsideInFormatId,
  type OutsideInLayout,
} from '@bendyline/docblocks/workspace-settings';

const UPDATE_FROM_MARKDOWN_KEY = 'squisq-updatefrommarkdown';
const HTML_OUTPUT_KEY = 'squisq-html-output';
const OUTPUT_TEMPLATE_KEY = 'squisq-output-template';

export type OutsideInHtmlOutput = 'interactive' | 'static';

interface OutsideInEditingModule {
  readOutsideInMetadata: (source: string | MarkdownDocument) => OutsideInMetadata | null;
  readOutsideInOutputTemplate?: (source: string | MarkdownDocument) => string | null;
  withOutsideInMetadata: (source: string, layout: OutsideInLayout) => string;
  isOutsideInMarkdownEditingEnabled?: (source: string | MarkdownDocument) => boolean;
  withOutsideInMarkdownEditing?: (
    source: string,
    layout: OutsideInLayout,
    enabled?: boolean,
  ) => string;
  importOutsideInDocument: (
    source: { data: ArrayBuffer | Uint8Array; targetPath: string },
    options?: ConvertOptions,
  ) => Promise<{ markdown: string; container: ContentContainer }>;
  renderOutsideInDocument: (
    source: {
      markdown: string | MarkdownDocument;
      targetPath: string;
      container?: ContentContainer;
    },
    options?: OutsideInConvertOptions,
  ) => Promise<ConversionResult>;
}

/**
 * Render options. `renderDiagram` pictures the diagrams Word, PDF, and
 * PowerPoint cannot draw; a Squisq release that predates it ignores it.
 */
type OutsideInConvertOptions = ConvertOptions & {
  html?: { playerScriptPath: string; basePath?: string };
  renderDiagram?: DiagramRasterizer;
};

/** The pdf.js worker URL the host supplied, and the one Squisq last received. */
let pdfWorkerSrc: string | null = null;
let configuredPdfWorkerSrc: string | null = null;

/**
 * Supply the pdf.js worker for PDF imports. pdf.js 4 parses nothing without
 * a worker URL ("No GlobalWorkerOptions.workerSrc specified"), and only the
 * host's bundler can produce one, so surfaces pass it as `pdfWorkerSrc`.
 */
export function setOutsideInPdfWorker(src: string | null | undefined): void {
  pdfWorkerSrc = src ?? null;
}

async function loadOutsideInModule(): Promise<OutsideInEditingModule> {
  const outsideIn = await import('@bendyline/squisq-formats/outside-in');
  // Configured here rather than at startup: every PDF import passes through
  // this loader, and the PDF module is fetched only once a conversion needs it.
  if (pdfWorkerSrc && pdfWorkerSrc !== configuredPdfWorkerSrc) {
    const { configurePdfWorker } = await import('@bendyline/squisq-formats/pdf');
    configurePdfWorker(pdfWorkerSrc);
    configuredPdfWorkerSrc = pdfWorkerSrc;
  }
  return outsideIn as unknown as OutsideInEditingModule;
}

export interface OutsideInMetadata {
  version: 1;
  format: OutsideInFormatId;
  target: string;
  updateFromMarkdown: boolean;
}

export async function readOutsideInMetadata(source: string): Promise<OutsideInMetadata | null> {
  const { readOutsideInMetadata: readMetadata } = await loadOutsideInModule();
  const metadata = readMetadata(source);
  return metadata
    ? {
        ...metadata,
        updateFromMarkdown: await isOutsideInMarkdownEditingEnabled(source),
      }
    : null;
}

export async function withOutsideInMetadata(
  source: string,
  layout: OutsideInLayout,
): Promise<string> {
  const { withOutsideInMetadata: addMetadata } = await loadOutsideInModule();
  return addMetadata(source, layout);
}

export async function isOutsideInMarkdownEditingEnabled(source: string): Promise<boolean> {
  const module = await loadOutsideInModule();
  if (module.isOutsideInMarkdownEditingEnabled) {
    return module.isOutsideInMarkdownEditingEnabled(source);
  }
  const { parseFrontmatter, splitFrontmatterBlock } = await import('@bendyline/squisq/markdown');
  const block = splitFrontmatterBlock(source).frontmatter;
  if (!block) return false;
  const firstBreak = block.indexOf('\n');
  if (firstBreak < 0) return false;
  const yaml = block.slice(firstBreak + 1).replace(/\r?\n---(?:\r?\n)?$/, '');
  return parseFrontmatter(yaml)?.[UPDATE_FROM_MARKDOWN_KEY] === true;
}

export async function withOutsideInMarkdownEditing(
  source: string,
  layout: OutsideInLayout,
  enabled = true,
): Promise<string> {
  const module = await loadOutsideInModule();
  if (module.withOutsideInMarkdownEditing) {
    return module.withOutsideInMarkdownEditing(source, layout, enabled);
  }
  const { setFrontmatterValues } = await import('@bendyline/squisq/markdown');
  return setFrontmatterValues(await withOutsideInMetadata(source, layout), {
    [UPDATE_FROM_MARKDOWN_KEY]: enabled,
  });
}

/**
 * Read the authored HTML output choice for a newly created Web page. Older
 * outside-in HTML documents have no value and retain the historical rendered
 * player behavior.
 */
export async function readOutsideInHtmlOutput(source: string): Promise<OutsideInHtmlOutput | null> {
  const { parseFrontmatter, splitFrontmatterBlock } = await import('@bendyline/squisq/markdown');
  const block = splitFrontmatterBlock(source).frontmatter;
  if (!block) return null;
  const firstBreak = block.indexOf('\n');
  if (firstBreak < 0) return null;
  const yaml = block.slice(firstBreak + 1).replace(/\r?\n---(?:\r?\n)?$/, '');
  const value = parseFrontmatter(yaml)?.[HTML_OUTPUT_KEY];
  return value === 'interactive' || value === 'static' ? value : null;
}

/**
 * The theme a document names for itself in frontmatter (`squisq-theme`, or
 * the legacy `themeId` / `theme`), read without parsing the whole body.
 */
export async function readFrontmatterTheme(source: string): Promise<string | undefined> {
  const { parseFrontmatter, readFrontmatterThemeId, splitFrontmatterBlock } =
    await import('@bendyline/squisq/markdown');
  const block = splitFrontmatterBlock(source).frontmatter;
  if (!block) return undefined;
  const firstBreak = block.indexOf('\n');
  if (firstBreak < 0) return undefined;
  const yaml = block.slice(firstBreak + 1).replace(/\r?\n---(?:\r?\n)?$/, '');
  return readFrontmatterThemeId(parseFrontmatter(yaml) ?? undefined);
}

/**
 * The page template a companion names for its rendered output: the authored
 * path, `'none'` when it opts out of the workspace default, or null when it
 * names none.
 */
export async function readOutsideInOutputTemplate(source: string): Promise<string | null> {
  const module = await loadOutsideInModule();
  if (module.readOutsideInOutputTemplate) return module.readOutsideInOutputTemplate(source);
  const { parseFrontmatter, splitFrontmatterBlock } = await import('@bendyline/squisq/markdown');
  const block = splitFrontmatterBlock(source).frontmatter;
  if (!block) return null;
  const firstBreak = block.indexOf('\n');
  if (firstBreak < 0) return null;
  const yaml = block.slice(firstBreak + 1).replace(/\r?\n---(?:\r?\n)?$/, '');
  const value = parseFrontmatter(yaml)?.[OUTPUT_TEMPLATE_KEY];
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().toLowerCase() === 'none' ? 'none' : value.trim();
}

/** Squisq's HTML page template engine (`@bendyline/squisq-formats/html`). */
export interface PageTemplateEngine {
  markdownDocToPlainHtmlParts: (
    doc: MarkdownDocument,
    options: PlainHtmlRenderOptions,
  ) => { title: string; bodyHtml: string; featureHeadHtml: string };
  applyHtmlPageTemplate: (
    template: string,
    content: {
      bodyHtml: string;
      headHtml?: string;
      title: string;
      values?: Readonly<Record<string, string | undefined>>;
    },
    options?: { templatePath?: string; outputPath?: string },
  ) => string;
  isHtmlPageTemplate: (html: string) => boolean;
  inspectHtmlPageTemplate: (html: string) => {
    isTemplate: boolean;
    errors: ReadonlyArray<{ message: string; line: number }>;
  };
}

/**
 * Squisq's preparation of a document for a script-free page
 * (`prepareMarkdownDocForPlainHtml`): data references filled from their
 * sidecars, and diagrams and charts swapped for pictures, returned as
 * `data:` URLs keyed by the image URL written into the document. A release
 * that also returns `icons` draws inline icons as SVG, so the page needs no
 * Font Awesome stylesheet.
 */
export type PlainHtmlPreparation = (
  doc: MarkdownDocument,
  options: { renderDiagram?: DiagramRasterizer; container?: ContentContainer | null },
) => Promise<{
  markdownDoc: MarkdownDocument;
  images: Map<string, string>;
  icons?: PlainHtmlIcons;
}>;

/** Icon outlines for the plain renderer's `icons` option, passed through as is. */
export type PlainHtmlIcons = ReadonlyMap<string, { width: number; height: number; path: string }>;

/** What DocBlocks passes Squisq's plain-HTML renderer. */
export interface PlainHtmlRenderOptions {
  title?: string;
  images?: Map<string, string>;
  links?: Map<string, string>;
  /** Ignored by a Squisq release that predates SVG icons. */
  icons?: PlainHtmlIcons;
  themeId?: string;
}

/**
 * Squisq's plain-HTML renderer (`markdownDocToPlainHtml`), typed
 * structurally so DocBlocks builds against releases with or without `icons`.
 */
export async function loadPlainHtmlRenderer(): Promise<
  (doc: MarkdownDocument, options: PlainHtmlRenderOptions) => string
> {
  const { markdownDocToPlainHtml } = await import('@bendyline/squisq-formats/html');
  return markdownDocToPlainHtml as unknown as (
    doc: MarkdownDocument,
    options: PlainHtmlRenderOptions,
  ) => string;
}

/**
 * Load the static-page preparation, or null when the installed Squisq
 * predates it; its pages then show diagrams as their source.
 */
export async function loadPlainHtmlPreparation(): Promise<PlainHtmlPreparation | null> {
  const html = (await import('@bendyline/squisq-formats/html')) as unknown as {
    prepareMarkdownDocForPlainHtml?: unknown;
  };
  return typeof html.prepareMarkdownDocForPlainHtml === 'function'
    ? (html.prepareMarkdownDocForPlainHtml as PlainHtmlPreparation)
    : null;
}

/**
 * Load the page template engine, or null when the installed Squisq predates
 * it. Typed structurally so DocBlocks builds against either release.
 */
export async function loadPageTemplateEngine(): Promise<PageTemplateEngine | null> {
  const html = (await import('@bendyline/squisq-formats/html')) as unknown as Partial<
    Record<keyof PageTemplateEngine, unknown>
  >;
  return typeof html.markdownDocToPlainHtmlParts === 'function' &&
    typeof html.applyHtmlPageTemplate === 'function' &&
    typeof html.isHtmlPageTemplate === 'function' &&
    typeof html.inspectHtmlPageTemplate === 'function'
    ? (html as PageTemplateEngine)
    : null;
}

/** Persist which Web page renderer every later outside-in save must use. */
export async function withOutsideInHtmlOutput(
  source: string,
  output: OutsideInHtmlOutput,
): Promise<string> {
  const { setFrontmatterValues } = await import('@bendyline/squisq/markdown');
  return setFrontmatterValues(source, { [HTML_OUTPUT_KEY]: output });
}

export async function importOutsideInDocument(
  source: { data: ArrayBuffer | Uint8Array; targetPath: string },
  options: ConvertOptions = {},
): Promise<{ layout: OutsideInLayout; markdown: string; container: ContentContainer }> {
  const { importOutsideInDocument: importDocument } = await loadOutsideInModule();
  const imported = await importDocument(source, options);
  const layout = resolveOutsideInLayout(source.targetPath);
  if (!layout) throw new Error(`Outside-in editing does not support "${source.targetPath}".`);
  return { ...imported, layout };
}

/** True for rendered formats whose companion Markdown references data sidecars. */
export function isOutsideInDataFormat(format: OutsideInFormatId): format is 'csv' | 'xlsx' {
  return format === 'csv' || format === 'xlsx';
}

/**
 * Import a data document outside-in without expanding its rows into Markdown.
 *
 * CSV and XLSX files selected as documents are the data, not prose that happens
 * to contain large Markdown tables. Keep the byte-exact source in the companion
 * container and let Squisq's virtualized data cards resolve the small reference
 * document. The CSV branch is intentionally parse-free, so files beyond the
 * inline CSV row and cell limits can still be dropped into a workspace. XLSX
 * still reads workbook structure so each sheet/region gets its own addressable
 * reference block, but never writes those cell grids into Markdown.
 */
export async function importOutsideInDataSidecar(source: {
  data: ArrayBuffer | Uint8Array;
  targetPath: string;
}): Promise<{ layout: OutsideInLayout; markdown: string; container: ContentContainer }> {
  const layout = resolveOutsideInLayout(source.targetPath);
  if (!layout || !isOutsideInDataFormat(layout.format)) {
    throw new Error(`Outside-in data import does not support "${source.targetPath}".`);
  }

  const data =
    source.data instanceof ArrayBuffer
      ? source.data
      : (source.data.buffer.slice(
          source.data.byteOffset,
          source.data.byteOffset + source.data.byteLength,
        ) as ArrayBuffer);
  const sourceName =
    source.targetPath.replace(/\\/g, '/').split('/').pop() ?? `data.${layout.format}`;
  const container =
    layout.format === 'csv'
      ? await import('@bendyline/squisq-formats/csv').then(({ csvToContainer }) =>
          csvToContainer(data, { sourceName, sidecar: 'always' }),
        )
      : await import('@bendyline/squisq-formats/xlsx').then(({ xlsxToContainer }) =>
          xlsxToContainer(data, {
            sourceName,
            sidecar: 'always',
            sheetHeadings: false,
          }),
        );
  const importedMarkdown = await container.readDocument();
  if (importedMarkdown === null) {
    throw new Error(
      `The ${layout.format.toUpperCase()} importer did not create a Markdown companion.`,
    );
  }

  return {
    layout,
    markdown: await withOutsideInMetadata(importedMarkdown, layout),
    container,
  };
}

export async function renderOutsideInDocument(
  source: { markdown: string | MarkdownDocument; targetPath: string; container?: ContentContainer },
  options: OutsideInConvertOptions = {},
): Promise<ConversionResult> {
  const { renderOutsideInDocument: renderDocument } = await loadOutsideInModule();
  return renderDocument(source, options);
}
