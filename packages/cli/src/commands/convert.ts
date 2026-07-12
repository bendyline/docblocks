/**
 * convert command
 *
 * Reads a markdown file, ZIP/DBK container, or folder and exports to
 * supported formats: DOCX, PPTX, PDF, HTML, and container ZIP (.dbk).
 *
 * Wraps the same logic as squisq-cli's convert command, reusing the
 * underlying squisq libraries directly.
 */

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, basename, extname, join, resolve } from 'node:path';
import { Command } from 'commander';
import type { MarkdownDocument } from '@bendyline/squisq/markdown';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { Block, Doc } from '@bendyline/squisq/schemas';

const ALL_FORMATS = ['docx', 'pptx', 'pdf', 'html', 'dbk'] as const;
type Format = (typeof ALL_FORMATS)[number];

function parseFormats(value: string): Format[] {
  const requested = value.split(',').map((s) => s.trim().toLowerCase());
  const valid: Format[] = [];
  for (const r of requested) {
    if (ALL_FORMATS.includes(r as Format)) {
      valid.push(r as Format);
    } else {
      console.warn(`Unknown format "${r}" — skipping. Valid: ${ALL_FORMATS.join(', ')}`);
    }
  }
  if (valid.length === 0) {
    throw new Error(`No valid formats specified. Valid: ${ALL_FORMATS.join(', ')}`);
  }
  return valid;
}

export interface ConvertOptions {
  outputDir?: string;
  formats?: string;
  theme?: string;
  transform?: string;
}

export interface ConvertResult {
  outputFiles: { path: string; format: string; size: number }[];
}

export async function runConvert(inputPath: string, opts: ConvertOptions): Promise<ConvertResult> {
  const resolvedInput = resolve(inputPath);
  const formats: Format[] = opts.formats ? parseFormats(opts.formats) : [...ALL_FORMATS];
  const outputDir = opts.outputDir ? resolve(opts.outputDir) : dirname(resolvedInput);
  const inputBasename = basename(resolvedInput);
  const inputExt = extname(inputBasename);
  const baseName = inputExt ? inputBasename.slice(0, -inputExt.length) : inputBasename;

  await mkdir(outputDir, { recursive: true });

  // Validate theme
  if (opts.theme) {
    const { getAvailableThemes } = await import('@bendyline/squisq/schemas');
    const themes = getAvailableThemes();
    if (!themes.includes(opts.theme)) {
      throw new Error(`Unknown theme "${opts.theme}". Available: ${themes.join(', ')}`);
    }
  }

  // Validate transform
  if (opts.transform) {
    const { getTransformStyleIds } = await import('@bendyline/squisq/transform');
    const styles = getTransformStyleIds();
    if (!styles.includes(opts.transform)) {
      throw new Error(
        `Unknown transform style "${opts.transform}". Available: ${styles.join(', ')}`,
      );
    }
  }

  console.error(`Reading: ${resolvedInput}`);
  const { readInput } = await import('@bendyline/squisq-cli/api');
  const result = await readInput(resolvedInput);
  const { container } = result;

  if (!result.markdownDoc) {
    throw new Error(
      'Convert command requires a markdown document. JSON Doc input is not supported for convert — use the video command instead.',
    );
  }

  // Apply transform if requested
  let exportMarkdownDoc = result.markdownDoc;
  if (opts.transform) {
    exportMarkdownDoc = await applyTransformToMarkdown(
      result.markdownDoc,
      container,
      opts.transform,
      opts.theme,
    );
    console.error(`  Applied transform: ${opts.transform}`);
  }

  const themeId = opts.theme;
  const outputFiles: ConvertResult['outputFiles'] = [];

  for (const format of formats) {
    const outPath = join(outputDir, `${baseName}.${format}`);
    const buf = await exportToFormat(format, exportMarkdownDoc, container, baseName, themeId);
    await writeFile(outPath, buf);
    const info = await stat(outPath);
    outputFiles.push({ path: outPath, format, size: info.size });
    console.error(`  ✓ ${outPath}`);
  }

  console.error('Done.');
  return { outputFiles };
}

async function exportToFormat(
  format: Format,
  markdownDoc: MarkdownDocument,
  container: ContentContainer,
  baseName: string,
  themeId?: string,
): Promise<Buffer | Uint8Array | string> {
  switch (format) {
    case 'docx': {
      const { markdownDocToDocx } = await import('@bendyline/squisq-formats/docx');
      const buf = await markdownDocToDocx(markdownDoc, { themeId });
      return Buffer.from(buf);
    }

    case 'pptx': {
      const { markdownDocToPptx } = await import('@bendyline/squisq-formats/pptx');
      const images = await collectContainerImages(container);
      const buf = await markdownDocToPptx(markdownDoc, { themeId, images });
      return Buffer.from(buf);
    }

    case 'pdf': {
      const { markdownDocToPdf } = await import('@bendyline/squisq-formats/pdf');
      const buf = await markdownDocToPdf(markdownDoc, { themeId });
      return Buffer.from(buf);
    }

    case 'html': {
      const { markdownToDoc } = await import('@bendyline/squisq/doc');
      const { docToHtml, collectImagePaths } = await import('@bendyline/squisq-formats/html');
      const { PLAYER_BUNDLE } = await import('@bendyline/squisq-react/standalone-source');

      const doc = markdownToDoc(markdownDoc);
      const imagePaths = collectImagePaths(doc);
      const images = new Map<string, ArrayBuffer>();
      for (const imgPath of imagePaths) {
        const data = await container.readFile(imgPath);
        if (data) {
          images.set(imgPath, data);
        }
      }

      return docToHtml(doc, {
        playerScript: PLAYER_BUNDLE,
        images,
        title: baseName,
        mode: 'static',
        themeId,
      });
    }

    case 'dbk': {
      const { containerToZip } = await import('@bendyline/squisq-formats/container');
      const blob = await containerToZip(container);
      const buf = await blob.arrayBuffer();
      return Buffer.from(buf);
    }
  }
}

/**
 * Apply a transform style to a MarkdownDocument.
 */
export async function applyTransformToMarkdown(
  markdownDoc: MarkdownDocument,
  container: ContentContainer,
  transformStyle: string,
  themeId?: string,
): Promise<MarkdownDocument> {
  const { markdownToDoc, docToMarkdown } = await import('@bendyline/squisq/doc');
  const { readFrontmatterThemeId } = await import('@bendyline/squisq/markdown');
  const { applyTransform, extractDocImages } = await import('@bendyline/squisq/transform');

  const doc = markdownToDoc(markdownDoc);
  const images = extractDocImages(doc.blocks);
  const effectiveTheme = themeId ?? readFrontmatterThemeId(markdownDoc.frontmatter);
  const result = applyTransform(doc, transformStyle, { themeId: effectiveTheme, images });
  const projected = projectTransformOntoMarkdownSource(doc, result.doc);
  const transformedMarkdown = docToMarkdown(projected);
  const resolvedTheme = effectiveTheme ?? result.doc.themeId ?? doc.themeId;
  if (!resolvedTheme) return transformedMarkdown;
  return {
    ...transformedMarkdown,
    frontmatter: {
      ...(transformedMarkdown.frontmatter ?? {}),
      'squisq-theme': resolvedTheme,
    },
  };
}

/**
 * Squisq transforms produce a presentation Doc whose generated highlight
 * blocks intentionally replace source blocks. Those generated blocks do not
 * carry Markdown authoring nodes, so serializing the transformed Doc directly
 * can drop complete sections. Project each selected visual template back onto
 * its source block instead: the style remains material while the authored
 * headings, body content, media references, and hierarchy stay intact.
 */
function projectTransformOntoMarkdownSource(source: Doc, transformed: Doc): Doc {
  const candidatesBySource = new Map<string, Block[]>();
  const timedSourceBlocks = collectTransformSourceBlocks(source.blocks).sort(
    (left, right) => left.startTime - right.startTime,
  );

  const collectCandidates = (blocks: readonly Block[]): void => {
    for (const block of blocks) {
      const provenance = block as Block & {
        sourceBlockId?: string;
        sourceStartTime?: number;
      };
      const sourceBlockId =
        provenance.sourceBlockId ??
        findSourceBlockAtTime(timedSourceBlocks, provenance.sourceStartTime)?.id;
      if (sourceBlockId && block.template) {
        const candidates = candidatesBySource.get(sourceBlockId) ?? [];
        candidates.push(block);
        candidatesBySource.set(sourceBlockId, candidates);
      }
      if (block.children) collectCandidates(block.children);
    }
  };
  collectCandidates(transformed.blocks);

  const projectBlock = (block: Block): Block => {
    const children = block.children?.map(projectBlock);
    const visual = selectVisualCandidate(candidatesBySource.get(block.id));
    if (!visual || !block.sourceHeading) {
      return { ...block, ...(children ? { children } : {}) };
    }

    const { autoTemplate: _autoTemplate, ...sourceBlock } = block;
    void _autoTemplate;
    const templateOverrides = {
      ...visual.overrides,
      ...(block.sourceHeading.templateAnnotation?.params ?? {}),
      ...(block.templateOverrides ?? {}),
    };
    const sourceHeading = {
      ...block.sourceHeading,
      templateAnnotation: {
        ...(block.sourceHeading.templateAnnotation ?? {}),
        template: visual.block.template,
        ...(Object.keys(templateOverrides).length > 0 ? { params: templateOverrides } : {}),
      },
    };

    return {
      ...sourceBlock,
      ...(children ? { children } : {}),
      template: visual.block.template,
      templateOverrides,
      sourceHeading,
      ...(block.transition || visual.block.transition
        ? { transition: block.transition ?? visual.block.transition }
        : {}),
    };
  };

  return {
    ...source,
    blocks: source.blocks.map(projectBlock),
    themeId: transformed.themeId ?? source.themeId,
  };
}

function collectTransformSourceBlocks(blocks: readonly Block[]): Block[] {
  const sourceBlocks: Block[] = [];
  for (const block of blocks) {
    if (block.children && block.children.length > 0) {
      if (!block.contents || block.contents.length === 0) sourceBlocks.push(block);
      sourceBlocks.push(...collectTransformSourceBlocks(block.children));
    } else {
      sourceBlocks.push(block);
    }
  }
  return sourceBlocks;
}

function findSourceBlockAtTime(
  sourceBlocks: readonly Block[],
  sourceStartTime: number | undefined,
): Block | undefined {
  if (sourceStartTime === undefined) return undefined;
  let match: Block | undefined;
  for (const block of sourceBlocks) {
    if (block.startTime > sourceStartTime) break;
    match = block;
  }
  return match;
}

interface ProjectedVisual {
  block: Block;
  overrides: Record<string, string>;
}

function selectVisualCandidate(
  candidates: readonly Block[] | undefined,
): ProjectedVisual | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  for (const candidate of candidates) {
    if (
      candidate.id.startsWith('transform-header-') ||
      candidate.id.startsWith('transform-img-') ||
      candidate.template === 'sectionHeader'
    ) {
      continue;
    }
    const overrides = serializeVisualInputs(candidate);
    if (overrides) return { block: candidate, overrides };
  }
  return undefined;
}

function serializeVisualInputs(block: Block): Record<string, string> | undefined {
  const input = block as unknown as Record<string, unknown>;
  switch (block.template) {
    case 'title':
      return serializeStringInputs(input, ['title'], ['subtitle', 'backgroundColor']);
    case 'statHighlight':
      return serializeStringInputs(input, ['stat', 'description'], ['detail', 'colorScheme']);
    case 'quote':
      return serializeStringInputs(input, ['quote'], ['attribution']);
    case 'fullBleedQuote':
      return serializeStringInputs(input, ['text'], ['colorScheme']);
    case 'factCard':
      return serializeStringInputs(input, ['fact', 'explanation'], ['source']);
    case 'definitionCard':
      return serializeStringInputs(input, ['term', 'definition'], ['origin', 'colorScheme']);
    case 'dateEvent':
      return serializeStringInputs(input, ['date', 'description'], ['footer', 'mood']);
    case 'twoColumn': {
      const left = serializeLabeledPair(input.left);
      const right = serializeLabeledPair(input.right);
      if (!left || !right) return undefined;
      return {
        left,
        right,
        ...(serializeStringInputs(input, [], ['header', 'leftColor', 'rightColor']) ?? {}),
      };
    }
    default:
      // Some template inputs (lists, images, tables, and custom templates)
      // are structured and cannot be represented losslessly in one inline
      // annotation. Keep their source Markdown unchanged instead of emitting
      // a visually empty or corrupt template block.
      return undefined;
  }
}

function serializeStringInputs(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): Record<string, string> | undefined {
  const serialized: Record<string, string> = {};
  for (const key of required) {
    const value = input[key];
    if (typeof value !== 'string') return undefined;
    serialized[key] = value;
  }
  for (const key of optional) {
    const value = input[key];
    if (typeof value === 'string') serialized[key] = value;
  }
  return serialized;
}

function serializeLabeledPair(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const pair = value as Record<string, unknown>;
  if (typeof pair.label !== 'string') return undefined;
  return typeof pair.sublabel === 'string' && pair.sublabel
    ? `${pair.label}|${pair.sublabel}`
    : pair.label;
}

async function collectContainerImages(
  container: ContentContainer,
): Promise<Map<string, ArrayBuffer>> {
  const images = new Map<string, ArrayBuffer>();
  const files = await container.listFiles();
  for (const file of files) {
    if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)$/i.test(file.path)) {
      const data = await container.readFile(file.path);
      if (data) {
        images.set(file.path, data);
      }
    }
  }
  return images;
}

export const convertCommand = new Command('convert')
  .description('Convert a markdown document to DOCX, PPTX, PDF, HTML, and DBK container formats')
  .argument('<input>', 'Path to .md file, .zip/.dbk container, or folder')
  .option('-o, --output-dir <dir>', 'Output directory (default: same as input)')
  .option(
    '-f, --formats <list>',
    `Comma-separated formats to produce (default: all). Valid: ${ALL_FORMATS.join(', ')}`,
  )
  .option('-t, --theme <id>', 'Squisq theme ID to apply (e.g., documentary, cinematic, bold)')
  .option(
    '--transform <style>',
    'Transform style to apply before export (e.g., documentary, magazine, minimal)',
  )
  .action(async (inputPath: string, opts: ConvertOptions) => {
    try {
      await runConvert(inputPath, opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  });
