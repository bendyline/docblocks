/**
 * convert command
 *
 * Reads any input supported by the linked Squisq CLI and exports through its
 * canonical format registry. The historical default set remains DOCX, PPTX,
 * PDF, HTML, and DBK; callers may explicitly request any export-capable
 * registry format.
 *
 * Wraps the same logic as squisq-cli's convert command, reusing the
 * underlying squisq libraries directly.
 */

import { mkdir, open, opendir, realpath, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, basename, extname, join, resolve } from 'node:path';
import { Command } from 'commander';
import type { MarkdownDocument } from '@bendyline/squisq/markdown';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { Block, Doc } from '@bendyline/squisq/schemas';
import type { ConvertSource, FormatId, FormatRegistry } from '@bendyline/squisq-cli/api';

const DEFAULT_FORMATS = ['docx', 'pptx', 'pdf', 'html', 'dbk'] as const;

export interface ConvertOptions {
  outputDir?: string;
  formats?: string;
  theme?: string;
  transform?: string;
  /** Cancel reading, transformation, conversion, or publication at a bounded boundary. */
  signal?: AbortSignal;
  /** Programmatic registry override; the CLI defaults to the linked Squisq registry. */
  registry?: FormatRegistry;
  /** Programmatic aggregate input budget; CLI callers use the safe default. */
  maxInputBytes?: number;
  /** Programmatic input-tree budget; CLI callers use the safe default. */
  maxInputEntries?: number;
  /** Programmatic per-output budget; CLI callers use the safe default. */
  maxOutputBytes?: number;
  /** Programmatic aggregate output budget; CLI callers use the safe default. */
  maxTotalOutputBytes?: number;
}

export interface ConvertResult {
  outputFiles: {
    path: string;
    format: string;
    size: number;
    mimeType: string;
    suggestedFilename: string;
    warnings: string[];
  }[];
}

const DEFAULT_MAX_CONVERT_INPUT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_CONVERT_INPUT_ENTRIES = 20_000;
const DEFAULT_MAX_CONVERT_OUTPUT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CONVERT_TOTAL_OUTPUT_BYTES = 1024 * 1024 * 1024;

export async function runConvert(inputPath: string, opts: ConvertOptions): Promise<ConvertResult> {
  throwIfAborted(opts.signal);
  const resolvedInput = resolve(inputPath);
  const outputDir = opts.outputDir ? resolve(opts.outputDir) : dirname(resolvedInput);
  const inputBasename = basename(resolvedInput);
  const inputExt = extname(inputBasename);
  const baseName = inputExt ? inputBasename.slice(0, -inputExt.length) : inputBasename;
  const maxInputBytes = positiveLimit(
    opts.maxInputBytes,
    DEFAULT_MAX_CONVERT_INPUT_BYTES,
    'input byte',
  );
  const maxInputEntries = positiveLimit(
    opts.maxInputEntries,
    DEFAULT_MAX_CONVERT_INPUT_ENTRIES,
    'input entry',
  );
  const maxOutputBytes = positiveLimit(
    opts.maxOutputBytes,
    DEFAULT_MAX_CONVERT_OUTPUT_BYTES,
    'output byte',
  );
  const maxTotalOutputBytes = positiveLimit(
    opts.maxTotalOutputBytes,
    DEFAULT_MAX_CONVERT_TOTAL_OUTPUT_BYTES,
    'aggregate output byte',
  );

  await assertInputWithinBudget(resolvedInput, maxInputBytes, maxInputEntries, opts.signal);

  const squisq = await import('@bendyline/squisq-cli/api');
  throwIfAborted(opts.signal);
  const registry = opts.registry ?? squisq.createCliRegistry();
  const exportableIds = registry
    .list()
    .filter((definition) => definition.exportDoc !== undefined)
    .map((definition) => definition.id);
  const exportable = new Set<FormatId>(exportableIds);
  const requested = opts.formats
    ? opts.formats
        .split(',')
        .map((format) => format.trim().toLowerCase())
        .filter(Boolean)
    : [...DEFAULT_FORMATS];
  const formats = requested.filter((format): format is FormatId => exportable.has(format));
  const unknown = requested.filter((format) => !exportable.has(format));

  if (unknown.length > 0) {
    console.warn(
      `Unknown or non-exportable format${unknown.length === 1 ? '' : 's'} "${unknown.join(', ')}" — skipping. Valid: ${exportableIds.join(', ')}`,
    );
  }
  if (formats.length === 0) {
    throw new squisq.ConversionError(
      'unknown-format',
      `No valid formats specified. Valid: ${exportableIds.join(', ')}`,
      {
        format: requested[0],
        hint: 'Choose a format reported by the linked Squisq CLI registry.',
      },
    );
  }

  await mkdir(outputDir, { recursive: true });
  throwIfAborted(opts.signal);

  // Validate transform
  if (opts.transform) {
    const { getTransformStyleIds } = await import('@bendyline/squisq/transform');
    throwIfAborted(opts.signal);
    const styles = getTransformStyleIds();
    if (!styles.includes(opts.transform)) {
      throw new Error(
        `Unknown transform style "${opts.transform}". Available: ${styles.join(', ')}`,
      );
    }
  }

  console.error(`Reading: ${resolvedInput}`);
  const result = await squisq.readInput(resolvedInput, { signal: opts.signal });
  throwIfAborted(opts.signal);
  const { container } = result;

  // Keep DocBlocks' source-preserving Markdown transform projection for
  // authored Markdown. JSON Doc inputs have no Markdown source to protect, so
  // they use the registry's native transform path below.
  let exportMarkdownDoc = result.markdownDoc;
  if (opts.transform && exportMarkdownDoc) {
    exportMarkdownDoc = await applyTransformToMarkdown(
      exportMarkdownDoc,
      container,
      opts.transform,
      opts.theme,
    );
    throwIfAborted(opts.signal);
    console.error(`  Applied transform: ${opts.transform}`);
  }

  const source: ConvertSource = exportMarkdownDoc
    ? { kind: 'markdown', markdown: exportMarkdownDoc, container, baseName }
    : { kind: 'doc', doc: result.doc, container, baseName };
  const outputFiles: ConvertResult['outputFiles'] = [];
  let totalOutputBytes = 0;

  for (const format of formats) {
    throwIfAborted(opts.signal);
    const conversion = await squisq.convert(source, format, {
      signal: opts.signal,
      registry,
      title: baseName,
      themeId: opts.theme,
      ...(!exportMarkdownDoc && opts.transform ? { transformStyle: opts.transform } : {}),
    });
    throwIfAborted(opts.signal);
    if (conversion.bytes.byteLength > maxOutputBytes) {
      throw new Error(`${format} output exceeds the ${maxOutputBytes}-byte conversion limit.`);
    }
    totalOutputBytes += conversion.bytes.byteLength;
    if (totalOutputBytes > maxTotalOutputBytes) {
      throw new Error(`Conversion outputs exceed the ${maxTotalOutputBytes}-byte aggregate limit.`);
    }
    const suggestedFilename = basename(conversion.suggestedFilename);
    const outPath = join(outputDir, suggestedFilename);
    await atomicReplaceFile(outPath, conversion.bytes, opts.signal);
    throwIfAborted(opts.signal);
    const info = await stat(outPath);
    throwIfAborted(opts.signal);
    outputFiles.push({
      path: outPath,
      format,
      size: info.size,
      mimeType: conversion.mimeType,
      suggestedFilename: conversion.suggestedFilename,
      warnings: [...conversion.warnings],
    });
    for (const warning of conversion.warnings) {
      console.error(`  Warning [${format}]: ${warning}`);
    }
    console.error(`  ✓ ${outPath}`);
  }

  console.error('Done.');
  return { outputFiles };
}

async function assertInputWithinBudget(
  inputPath: string,
  maxBytes: number,
  maxEntries: number,
  signal?: AbortSignal,
): Promise<void> {
  const rootInfo = await stat(inputPath);
  if (rootInfo.isFile()) {
    if (rootInfo.size > maxBytes) {
      throw new Error(`Conversion input exceeds the ${maxBytes}-byte limit.`);
    }
    return;
  }
  if (!rootInfo.isDirectory()) throw new Error(`Unsupported conversion input: ${inputPath}`);

  const pending = [inputPath];
  const visitedDirectories = new Set<string>();
  let entryCount = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    throwIfAborted(signal);
    const directory = pending.pop()!;
    const physicalDirectory = await realpath(directory);
    if (visitedDirectories.has(physicalDirectory)) continue;
    visitedDirectories.add(physicalDirectory);
    const entries = await opendir(directory);
    for await (const entry of entries) {
      throwIfAborted(signal);
      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new Error(`Conversion input exceeds the ${maxEntries}-entry limit.`);
      }
      const entryPath = join(directory, entry.name);
      const info = await stat(entryPath);
      if (info.isDirectory()) pending.push(entryPath);
      else if (info.isFile()) {
        totalBytes += info.size;
        if (totalBytes > maxBytes) {
          throw new Error(`Conversion input exceeds the ${maxBytes}-byte limit.`);
        }
      }
    }
  }
}

async function atomicReplaceFile(
  outputPath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    throwIfAborted(signal);
    await rename(temporaryPath, outputPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('Document conversion was cancelled');
  error.name = 'AbortError';
  throw error;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`Invalid conversion ${label} limit.`);
  }
  return selected;
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

export const convertCommand = new Command('convert')
  .description('Convert a document through the linked Squisq format registry')
  .argument('<input>', 'Path to a supported document, .zip/.dbk container, or folder')
  .option('-o, --output-dir <dir>', 'Output directory (default: same as input)')
  .option(
    '-f, --formats <list>',
    `Comma-separated linked Squisq export formats (default: ${DEFAULT_FORMATS.join(', ')})`,
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
      if (isConversionErrorMetadata(err)) {
        console.error(`  Code: ${err.code}${err.format ? ` (${err.format})` : ''}`);
        if (err.hint) console.error(`  Hint: ${err.hint}`);
      }
      process.exitCode = 1;
    }
  });

function isConversionErrorMetadata(
  error: unknown,
): error is Error & { code: string; format?: string; hint?: string } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; format?: unknown; hint?: unknown };
  if (typeof candidate.code !== 'string') return false;
  if (candidate.format !== undefined && typeof candidate.format !== 'string') {
    return false;
  }
  return candidate.hint === undefined || typeof candidate.hint === 'string';
}
