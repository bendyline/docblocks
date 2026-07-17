import type {
  BlockSummary,
  ComparisonChange,
  ComparisonMetric,
  ComparisonResult,
  DiagnosticSeverity,
  DiagnosticStage,
  InspectionResult,
  McpDiagnostic,
  OutlineEntry,
  ThemeSummary,
  ValidationResult,
} from '@bendyline/docblocks/mcp';
import { DOCBLOCKS_MCP_WIRE_VERSION, MCP_WIRE_LIMITS } from '@bendyline/docblocks/mcp';
import type { DocDiagnostic } from '@bendyline/squisq/schemas';
import type { TemplateAuthoringMetadata } from '@bendyline/squisq/doc';
import type { PreparedDocument } from './document-service.js';
import { DocumentService, throwIfAborted, warningDiagnostic } from './document-service.js';
import { boundWireText, toWireIdentifier } from './output-bounds.js';
import { analyzeDocumentBlocks } from './block-analysis.js';

const DEFAULT_MAX_INSPECTION_BLOCKS = 200;
const MAX_INSPECTION_BLOCKS = 2_000;
/** Producer budget keeps worst-case diagnostics comfortably within the default report quota. */
export const MCP_MAX_PUBLISHED_DIAGNOSTICS = 500;
const MAX_DIAGNOSTICS = MCP_MAX_PUBLISHED_DIAGNOSTICS;
const FORMAT_PATTERN = /^[a-z0-9][a-z0-9.+_-]{0,63}$/u;
const CANCELLATION_YIELD_INTERVAL = 256;

export async function inspectPreparedDocument(
  _documents: DocumentService,
  prepared: PreparedDocument,
  maximumBlocks = DEFAULT_MAX_INSPECTION_BLOCKS,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<InspectionResult> {
  throwIfAborted(signal);
  if (
    !Number.isSafeInteger(maximumBlocks) ||
    maximumBlocks < 1 ||
    maximumBlocks > MAX_INSPECTION_BLOCKS
  ) {
    throw new Error(`Inspection block limit must be between 1 and ${MAX_INSPECTION_BLOCKS}`);
  }
  const { flattenBlocks, validateMarkdownSource } = await import('@bendyline/squisq/doc');
  await yieldForCancellation(signal);
  const assets = prepared.assets;
  const assetPaths = new Set(assets.map((asset) => asset.path));
  const validation = validateMarkdownSource(prepared.markdown, { assets: assetPaths });
  const flatBlocks = flattenBlocks(prepared.doc.blocks);
  const analyzed = await analyzeDocumentBlocks(prepared.doc.blocks);
  throwIfAborted(signal);
  const blockOffset = parseInspectionCursor(cursor, analyzed.length);
  const blockEnd = Math.min(analyzed.length, blockOffset + maximumBlocks);
  const analyzedBlocks = analyzed.map((entry) => entry.block);
  const sourceRanges = await computeBlockSourceRanges(
    analyzedBlocks,
    prepared.markdown.length,
    signal,
  );
  const blocks: BlockSummary[] = analyzed.slice(blockOffset, blockEnd).map((entry, index) => ({
    id: toWireIdentifier(entry.block.id, 'block'),
    type: toWireIdentifier(entry.block.template ?? 'section', 'section'),
    text: boundWireText(entry.plainText, MCP_WIRE_LIMITS.excerptCharacters),
    wordCount: entry.bodyWordCount,
    templateId:
      entry.block.template === undefined
        ? null
        : toWireIdentifier(entry.block.template, 'template'),
    sourceRange: sourceRanges[blockOffset + index] ?? null,
  }));
  const outline = (
    await collectAnalyzedOutline(prepared.doc.blocks, analyzedBlocks, signal)
  ).filter((entry) => entry.blockIndex >= blockOffset && entry.blockIndex < blockEnd);
  const details = summarizeMarkdownNodes(prepared.markdownDoc);
  await yieldForCancellation(signal);
  const counts = { tables: details.tableCount, links: details.linkCount };
  const itemSummary = summarizeItems(prepared, flatBlocks, details.tables);
  const items = itemSummary.items;
  const metadata = metadataFromFrontmatter(prepared.markdownDoc.frontmatter);
  const diagnostics = [
    ...prepared.diagnostics,
    ...validation.diagnostics.map((diagnostic) =>
      mapDocDiagnostic(diagnostic, prepared.sourceFormat),
    ),
    ...missingAltTextDiagnostics(prepared.markdownDoc, prepared.sourceFormat),
    ...(await authoringDiagnostics(prepared, 'inspect', prepared.sourceFormat, signal)),
  ];
  let wordCount = 0;
  for (let index = 0; index < analyzed.length; index += 1) {
    wordCount += analyzed[index]?.bodyWordCount ?? 0;
    const checkpoint = cancellationCheckpoint(signal, index);
    if (checkpoint) await checkpoint;
  }
  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'inspection',
    sourceFormat: prepared.sourceFormat,
    metadata,
    statistics: {
      blockCount: analyzed.length,
      wordCount,
      characterCount: prepared.markdown.length,
      tableCount: counts.tables,
      linkCount: counts.links,
      assetCount: assets.length,
      pageCount: prepared.sourceFormat === 'pdf' ? items.length : null,
      slideCount: prepared.sourceFormat === 'pptx' ? items.length : null,
      sheetCount:
        prepared.sourceFormat === 'xlsx' || prepared.sourceFormat === 'csv' ? items.length : null,
    },
    outline,
    blocks,
    blockOffset,
    nextCursor: blockEnd < analyzed.length ? `blocks:${blockEnd}` : null,
    tables: details.tables,
    links: details.links,
    items,
    assets,
    theme: await themeSummary(prepared, signal),
    truncated: blockEnd < analyzed.length,
    detailsTruncated: details.truncated || itemSummary.truncated,
    diagnostics: boundDiagnostics(diagnostics, 'inspect'),
  };
}

export async function validatePreparedDocument(
  _documents: DocumentService,
  prepared: PreparedDocument,
  targetFormat: string | null,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  throwIfAborted(signal);
  const normalizedTargetFormat = normalizeTargetFormat(targetFormat);
  const { validateMarkdownSource } = await import('@bendyline/squisq/doc');
  await yieldForCancellation(signal);
  const assets = prepared.assets;
  const validation = validateMarkdownSource(prepared.markdown, {
    assets: new Set(assets.map((asset) => asset.path)),
  });
  throwIfAborted(signal);
  const diagnostics = [
    ...prepared.diagnostics,
    ...validation.diagnostics.map((diagnostic) =>
      mapDocDiagnostic(diagnostic, prepared.sourceFormat),
    ),
    ...missingAltTextDiagnostics(
      prepared.markdownDoc,
      normalizedTargetFormat ?? prepared.sourceFormat,
    ),
    ...(await authoringDiagnostics(
      prepared,
      'validate',
      normalizedTargetFormat ?? prepared.sourceFormat,
      signal,
    )),
    ...(normalizedTargetFormat
      ? await targetPreflight(prepared, normalizedTargetFormat, signal)
      : []),
  ];
  await yieldForCancellation(signal);
  const unique = boundDiagnostics(diagnostics, 'validate');
  throwIfAborted(signal);
  const summary = summarizeDiagnostics(unique);
  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'validation',
    sourceFormat: prepared.sourceFormat,
    targetFormat: normalizedTargetFormat,
    valid: summary.errorCount === 0,
    summary,
    diagnostics: unique,
  };
}

/** Detect authoring shapes that are syntactically valid but commonly surprise agents. */
export async function authoringDiagnostics(
  prepared: PreparedDocument,
  stage: DiagnosticStage,
  format: string,
  signal?: AbortSignal,
): Promise<McpDiagnostic[]> {
  throwIfAborted(signal);
  const {
    TEMPLATE_AUTHORING_METADATA,
    flattenBlocks,
    getBlockBodyText,
    materializeBlockLayers,
    resolveTemplateName,
    resolveThemeForDoc,
  } = await import('@bendyline/squisq/doc');
  const blocks = flattenBlocks(prepared.doc.blocks);
  const analyzedBlocks = blocks.slice(0, MCP_WIRE_LIMITS.arrayEntries);
  const theme = resolveThemeForDoc(prepared.doc);
  const diagnostics: McpDiagnostic[] = [];
  for (let index = 0; index < analyzedBlocks.length; index += 1) {
    const checkpoint = cancellationCheckpoint(signal, index);
    if (checkpoint) await checkpoint;
    const block = analyzedBlocks[index]!;
    throwIfAborted(signal);
    if (block.standaloneAnnotation) {
      diagnostics.push({
        code: 'standalone-template-block',
        severity: 'warning',
        stage,
        format,
        count: 1,
        message: `Block "${block.id}" was created by a standalone template annotation and has no heading.`,
        remediation:
          'Move the annotation onto the intended heading, for example `# Heading {[content]}`, unless the additional heading-less block is deliberate.',
        retryable: false,
        location: {
          kind: 'block',
          blockId: toWireIdentifier(block.id, 'block'),
          nodeType: 'block',
        },
      });
    }
    if (!block.template) continue;
    const templateId = resolveTemplateName(block.template);
    const behavior = (TEMPLATE_AUTHORING_METADATA as Record<string, TemplateAuthoringMetadata>)[
      templateId
    ];
    if (!behavior) continue;
    const body = getBlockBodyText(block).trim();
    if (!body) continue;
    if (behavior.bodyPolicy === 'ignored') {
      diagnostics.push({
        code: 'template-body-not-rendered',
        severity: 'warning',
        stage,
        format,
        count: 1,
        message: `Template "${templateId}" does not render the body of block "${block.title ?? block.id}".`,
        remediation:
          'Use the content template to preserve the complete body, or move this prose into a separate content block before visual optimization.',
        retryable: false,
        location: {
          kind: 'block',
          blockId: toWireIdentifier(block.id, 'block'),
          nodeType: 'block',
        },
      });
      continue;
    }
    if (behavior.bodyPolicy !== 'complete') continue;
    const materialized = materializeBlockLayers(block, {
      theme,
      customTemplates: prepared.doc.customTemplates,
      persistentLayers: false,
      blockIndex: index,
      totalBlocks: analyzedBlocks.length,
    });
    const renderedText = materialized.layers
      .filter((layer) => layer.type === 'text')
      .map((layer) => layer.content.text)
      .join('\n');
    if (!normalizedText(renderedText).includes(normalizedText(body))) {
      diagnostics.push({
        code: 'rendered-content-omitted',
        severity: 'error',
        stage,
        format,
        count: 1,
        message: `The complete body of block "${block.title ?? block.id}" is not present in its rendered text layers.`,
        remediation:
          'Keep the content template and repair its inputs, then validate and preview again before conversion.',
        retryable: false,
        location: {
          kind: 'block',
          blockId: toWireIdentifier(block.id, 'block'),
          nodeType: 'block',
        },
      });
    }
  }
  if (analyzedBlocks.length < blocks.length) {
    diagnostics.push({
      code: 'authoring-analysis-truncated',
      severity: 'info',
      stage,
      format,
      count: blocks.length - analyzedBlocks.length,
      message: `Authoring diagnostics analyzed the first ${analyzedBlocks.length} blocks.`,
      remediation:
        'Split the document before requesting exhaustive per-block authoring diagnostics.',
      retryable: false,
      location: null,
    });
  }
  return diagnostics;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

export async function comparePreparedDocuments(
  documents: DocumentService,
  left: PreparedDocument,
  right: PreparedDocument,
  signal?: AbortSignal,
): Promise<ComparisonResult> {
  throwIfAborted(signal);
  await yieldForCancellation(signal);
  const [leftInspection, rightInspection] = await Promise.all([
    inspectPreparedDocument(documents, left, MAX_INSPECTION_BLOCKS, null, signal),
    inspectPreparedDocument(documents, right, MAX_INSPECTION_BLOCKS, null, signal),
  ]);
  throwIfAborted(signal);
  const { stripMarkdown } = await import('@bendyline/squisq/generate');
  const leftWords = words(stripMarkdown(left.markdown));
  const rightWords = words(stripMarkdown(right.markdown));
  await yieldForCancellation(signal);
  const [textSimilarity, leftLayouts, rightLayouts, leftAccessibility, rightAccessibility] =
    await Promise.all([
      multisetSimilarity(leftWords, rightWords, signal),
      layoutTokens(left, signal),
      layoutTokens(right, signal),
      accessibilityTokens(left, signal),
      accessibilityTokens(right, signal),
    ]);
  const structureSimilarity = ratioSimilarity(
    leftInspection.statistics.blockCount,
    rightInspection.statistics.blockCount,
  );
  const tableSimilarity = ratioSimilarity(
    leftInspection.statistics.tableCount,
    rightInspection.statistics.tableCount,
  );
  const mediaSimilarity = assetSimilarity(leftInspection.assets, rightInspection.assets);
  const metadataSimilarity = objectSimilarity(leftInspection.metadata, rightInspection.metadata);
  const themeSimilarity =
    leftInspection.theme?.id === rightInspection.theme?.id
      ? 1
      : leftInspection.theme === null && rightInspection.theme === null
        ? 1
        : 0;
  const layoutSimilarity = await multisetSimilarity(leftLayouts, rightLayouts, signal);
  const leftTiming = timingSummary(left);
  const rightTiming = timingSummary(right);
  const timingSimilarity =
    (ratioSimilarity(leftTiming.duration, rightTiming.duration) +
      ratioSimilarity(leftTiming.segmentCount, rightTiming.segmentCount) +
      ratioSimilarity(leftTiming.captionCount, rightTiming.captionCount)) /
    3;
  const accessibilitySimilarity = await multisetSimilarity(
    leftAccessibility,
    rightAccessibility,
    signal,
  );
  throwIfAborted(signal);
  const score = clamp01(
    textSimilarity * 0.4 +
      structureSimilarity * 0.12 +
      tableSimilarity * 0.06 +
      mediaSimilarity * 0.12 +
      layoutSimilarity * 0.08 +
      metadataSimilarity * 0.05 +
      themeSimilarity * 0.06 +
      timingSimilarity * 0.05 +
      accessibilitySimilarity * 0.06,
  );
  const metrics: ComparisonMetric[] = [
    metric(
      'words',
      leftInspection.statistics.wordCount,
      rightInspection.statistics.wordCount,
      textSimilarity,
    ),
    metric(
      'blocks',
      leftInspection.statistics.blockCount,
      rightInspection.statistics.blockCount,
      structureSimilarity,
    ),
    metric(
      'tables',
      leftInspection.statistics.tableCount,
      rightInspection.statistics.tableCount,
      tableSimilarity,
    ),
    metric(
      'assets',
      leftInspection.statistics.assetCount,
      rightInspection.statistics.assetCount,
      mediaSimilarity,
    ),
    metric('layouts', leftLayouts.length, rightLayouts.length, layoutSimilarity),
    metric('durationSeconds', leftTiming.duration, rightTiming.duration, timingSimilarity),
    metric(
      'accessibilityFeatures',
      leftAccessibility.length,
      rightAccessibility.length,
      accessibilitySimilarity,
    ),
  ];
  const changes: ComparisonChange[] = [
    change(
      'text',
      textSimilarity,
      'Text content',
      leftInspection.statistics.wordCount,
      rightInspection.statistics.wordCount,
    ),
    change(
      'structure',
      structureSimilarity,
      'Document structure',
      leftInspection.statistics.blockCount,
      rightInspection.statistics.blockCount,
    ),
    change(
      'table',
      tableSimilarity,
      'Tables',
      leftInspection.statistics.tableCount,
      rightInspection.statistics.tableCount,
    ),
    change(
      'media',
      mediaSimilarity,
      'Media assets',
      leftInspection.statistics.assetCount,
      rightInspection.statistics.assetCount,
    ),
    change(
      'theme',
      themeSimilarity,
      'Theme',
      leftInspection.theme ? 1 : 0,
      rightInspection.theme ? 1 : 0,
    ),
    change(
      'layout',
      layoutSimilarity,
      'Layouts and templates',
      leftLayouts.length,
      rightLayouts.length,
    ),
    change(
      'metadata',
      metadataSimilarity,
      'Document metadata',
      metadataFieldCount(leftInspection),
      metadataFieldCount(rightInspection),
    ),
    change(
      'timing',
      timingSimilarity,
      'Audio and caption timing',
      leftTiming.segmentCount,
      rightTiming.segmentCount,
    ),
    change(
      'accessibility',
      accessibilitySimilarity,
      'Accessibility features',
      leftAccessibility.length,
      rightAccessibility.length,
    ),
  ];
  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'comparison',
    leftFormat: left.sourceFormat,
    rightFormat: right.sourceFormat,
    equivalent: score === 1 && changes.every((entry) => entry.status === 'retained'),
    score,
    changes,
    metrics,
    diagnostics: boundDiagnostics(
      [...leftInspection.diagnostics, ...rightInspection.diagnostics],
      'compare',
    ),
  };
}

async function collectAnalyzedOutline(
  blocks: PreparedDocument['doc']['blocks'],
  analyzedBlocks: readonly PreparedDocument['doc']['blocks'][number][],
  signal?: AbortSignal,
): Promise<OutlineEntry[]> {
  const levels = new Map<PreparedDocument['doc']['blocks'][number], number>();
  const pending = [...blocks].reverse().map((block) => ({ block, level: 1 }));
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    levels.set(current.block, current.level);
    const children = current.block.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const block = children[index];
      if (block) pending.push({ block, level: current.level + 1 });
    }
    const checkpoint = cancellationCheckpoint(signal, visited);
    if (checkpoint) await checkpoint;
    visited += 1;
  }
  const outline: OutlineEntry[] = [];
  for (let blockIndex = 0; blockIndex < analyzedBlocks.length; blockIndex += 1) {
    const block = analyzedBlocks[blockIndex];
    if (!block) continue;
    outline.push({
      id: toWireIdentifier(block.id, 'block'),
      title: boundWireText(
        block.title ?? block.sourceHeading?.children?.map(textFromNode).join('') ?? block.id,
        MCP_WIRE_LIMITS.labelCharacters,
        'Untitled block',
      ),
      level: levels.get(block) ?? 1,
      blockIndex,
    });
    const checkpoint = cancellationCheckpoint(signal, blockIndex);
    if (checkpoint) await checkpoint;
  }
  return outline;
}

function parseInspectionCursor(cursor: string | null, blockCount: number): number {
  if (cursor === null) return 0;
  const match = /^blocks:(0|[1-9][0-9]{0,9})$/u.exec(cursor);
  if (!match) throw new Error('Invalid inspection cursor');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset > blockCount) {
    throw new Error('Inspection cursor is outside the document');
  }
  return offset;
}

/** Compute heading ranges in one reverse pass while allowing protocol cancellation to run. */
export async function computeBlockSourceRanges(
  blocks: readonly Pick<PreparedDocument['doc']['blocks'][number], 'sourceHeading'>[],
  markdownLength: number,
  signal?: AbortSignal,
): Promise<Array<{ start: number; end: number } | null>> {
  const starts: Array<number | null> = new Array(blocks.length);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const position = block.sourceHeading?.position as { start?: { offset?: unknown } } | undefined;
    const offset = position?.start?.offset;
    starts[index] =
      typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0
        ? Math.min(offset, markdownLength)
        : null;
    const checkpoint = cancellationCheckpoint(signal, index);
    if (checkpoint) await checkpoint;
  }

  const ranges: Array<{ start: number; end: number } | null> = new Array(starts.length);
  let nextStart = markdownLength;
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const start = starts[index];
    if (start === null || start === undefined) {
      ranges[index] = null;
    } else {
      ranges[index] = { start, end: nextStart };
      nextStart = start;
    }
    const checkpoint = cancellationCheckpoint(signal, starts.length - index);
    if (checkpoint) await checkpoint;
  }
  return ranges;
}

function summarizeItems(
  prepared: PreparedDocument,
  blocks: readonly PreparedDocument['doc']['blocks'][number][],
  tables: readonly { index: number; headers: readonly string[] }[],
): { items: InspectionResult['items']; truncated: boolean } {
  if (prepared.sourceFormat === 'pptx' || prepared.sourceFormat === 'pdf') {
    const kind = prepared.sourceFormat === 'pptx' ? ('slide' as const) : ('page' as const);
    const all = blocks.length > 0 ? blocks : [null];
    return {
      items: all.slice(0, 1_000).map((block, index) => ({
        kind,
        index,
        label:
          block?.title === undefined
            ? `${kind} ${index + 1}`
            : boundWireText(block.title, MCP_WIRE_LIMITS.labelCharacters),
        blockIds: block ? [toWireIdentifier(block.id, 'block')] : [],
      })),
      truncated: all.length > 1_000,
    };
  }
  if (prepared.sourceFormat === 'xlsx' || prepared.sourceFormat === 'csv') {
    const total = Math.max(1, tables.length);
    return {
      items: Array.from({ length: Math.min(total, 1_000) }, (_unused, index) => ({
        kind: 'sheet' as const,
        index,
        label:
          tables[index]?.headers[0] === undefined
            ? `Sheet ${index + 1}`
            : boundWireText(tables[index].headers[0], MCP_WIRE_LIMITS.labelCharacters),
        blockIds: [],
      })),
      truncated: total > 1_000,
    };
  }
  return { items: [], truncated: false };
}

function textFromNode(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const candidate = node as { value?: unknown; children?: unknown };
  if (typeof candidate.value === 'string') return candidate.value;
  return Array.isArray(candidate.children) ? candidate.children.map(textFromNode).join('') : '';
}

function summarizeMarkdownNodes(markdownDoc: PreparedDocument['markdownDoc']): {
  tableCount: number;
  linkCount: number;
  tables: Array<{ index: number; rowCount: number; columnCount: number; headers: string[] }>;
  links: Array<{ index: number; text: string; target: string }>;
  truncated: boolean;
} {
  let tableCount = 0;
  let linkCount = 0;
  const tables: Array<{ index: number; rowCount: number; columnCount: number; headers: string[] }> =
    [];
  const links: Array<{ index: number; text: string; target: string }> = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const candidate = node as {
      type?: unknown;
      children?: unknown;
      url?: unknown;
      identifier?: unknown;
    };
    if (candidate.type === 'table') {
      const index = tableCount;
      tableCount += 1;
      if (tables.length < 1_000) {
        const rows = Array.isArray(candidate.children) ? candidate.children : [];
        const rowCells = rows.map((row) => {
          if (!row || typeof row !== 'object') return [];
          const children = (row as { children?: unknown }).children;
          return Array.isArray(children) ? children : [];
        });
        tables.push({
          index,
          rowCount: rowCells.length,
          columnCount: rowCells.reduce((maximum, cells) => Math.max(maximum, cells.length), 0),
          headers: (rowCells[0] ?? [])
            .slice(0, MCP_WIRE_LIMITS.arrayEntries)
            .map((cell) => boundWireText(textFromNode(cell), MCP_WIRE_LIMITS.labelCharacters)),
        });
      }
    }
    if (candidate.type === 'link' || candidate.type === 'linkReference') {
      const index = linkCount;
      linkCount += 1;
      if (links.length < 1_000) {
        const target =
          typeof candidate.url === 'string'
            ? candidate.url
            : typeof candidate.identifier === 'string'
              ? `reference:${candidate.identifier}`
              : 'unknown:';
        links.push({
          index,
          text: boundWireText(textFromNode(candidate), MCP_WIRE_LIMITS.labelCharacters),
          target: boundWireText(target, MCP_WIRE_LIMITS.uriCharacters, 'unknown:'),
        });
      }
    }
    if (Array.isArray(candidate.children)) candidate.children.forEach(visit);
  };
  visit(markdownDoc);
  return {
    tableCount,
    linkCount,
    tables,
    links,
    truncated: tableCount > tables.length || linkCount > links.length,
  };
}

function metadataFromFrontmatter(frontmatter: Record<string, unknown> | undefined): {
  title: string | null;
  author: string | null;
  description: string | null;
} {
  return {
    title: stringField(frontmatter, 'title', MCP_WIRE_LIMITS.labelCharacters),
    author: stringField(frontmatter, 'author', MCP_WIRE_LIMITS.labelCharacters),
    description: stringField(frontmatter, 'description', MCP_WIRE_LIMITS.messageCharacters),
  };
}

function stringField(
  frontmatter: Record<string, unknown> | undefined,
  key: string,
  maximumCharacters: number,
): string | null {
  const value = frontmatter?.[key];
  if (typeof value !== 'string' || !value) return null;
  const bounded = boundWireText(value, maximumCharacters);
  return bounded || null;
}

async function themeSummary(
  prepared: PreparedDocument,
  signal?: AbortSignal,
): Promise<ThemeSummary | null> {
  throwIfAborted(signal);
  const themeId = prepared.doc.themeId;
  if (!themeId) return null;
  const documentTheme = prepared.doc.customThemes?.find((theme) => theme.id === themeId);
  if (documentTheme) {
    return {
      id: toWireIdentifier(themeId, 'theme'),
      name: boundWireText(documentTheme.name ?? themeId, MCP_WIRE_LIMITS.labelCharacters, themeId),
      source: prepared.sourceFormat === 'pptx' ? 'inferred' : 'document',
      layouts: [
        ...new Set(
          prepared.doc.customTemplates
            ?.slice(0, MCP_WIRE_LIMITS.arrayEntries)
            .map((template) => boundWireText(template.name, MCP_WIRE_LIMITS.labelCharacters)) ?? [],
        ),
      ],
    };
  }
  const { getThemeSummaries } = await import('@bendyline/squisq/schemas');
  throwIfAborted(signal);
  const builtIn = getThemeSummaries().find((theme) => theme.id === themeId);
  return {
    id: toWireIdentifier(themeId, 'theme'),
    name: boundWireText(builtIn?.name ?? themeId, MCP_WIRE_LIMITS.labelCharacters, themeId),
    source: 'built-in',
    layouts: [
      ...new Set(
        prepared.doc.customTemplates
          ?.slice(0, MCP_WIRE_LIMITS.arrayEntries)
          .map((template) => boundWireText(template.name, MCP_WIRE_LIMITS.labelCharacters)) ?? [],
      ),
    ],
  };
}

function mapDocDiagnostic(diagnostic: DocDiagnostic, format: string): McpDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    stage: 'validate',
    format,
    count: 1,
    message: diagnostic.message,
    remediation: null,
    retryable: false,
    location: diagnostic.blockId
      ? {
          kind: 'block',
          blockId: toWireIdentifier(diagnostic.blockId, 'block'),
          nodeType: 'block',
        }
      : diagnostic.line
        ? { kind: 'source', line: diagnostic.line, column: 1 }
        : null,
  };
}

function missingAltTextDiagnostics(
  markdownDoc: PreparedDocument['markdownDoc'],
  format: string,
): McpDiagnostic[] {
  let missingCount = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const candidate = node as { type?: unknown; alt?: unknown; children?: unknown };
    if (
      candidate.type === 'image' &&
      (typeof candidate.alt !== 'string' || !candidate.alt.trim())
    ) {
      missingCount += 1;
    }
    if (Array.isArray(candidate.children)) candidate.children.forEach(visit);
  };
  visit(markdownDoc);
  if (missingCount === 0) return [];
  return [
    {
      code: 'missing-alt-text',
      severity: 'warning',
      stage: 'validate',
      format,
      count: missingCount,
      message:
        missingCount === 1
          ? 'One image has no alternative text.'
          : `${missingCount} images have no alternative text.`,
      remediation: 'Add concise, meaningful alternative text to every Markdown image.',
      retryable: false,
      location: null,
    },
  ];
}

async function targetPreflight(
  prepared: PreparedDocument,
  targetFormat: string,
  signal?: AbortSignal,
): Promise<McpDiagnostic[]> {
  throwIfAborted(signal);
  const normalized = targetFormat.toLowerCase();
  const { createCliRegistry } = await import('@bendyline/squisq-cli/api');
  throwIfAborted(signal);
  const target = createCliRegistry().get(normalized);
  if (!target?.exportDoc) {
    return [
      {
        code: target ? 'unsupported-output' : 'unknown-format',
        severity: 'error',
        stage: 'validate',
        format: normalized,
        count: 1,
        message: target
          ? `${target.label} cannot be used as a conversion target.`
          : `Unknown target format "${normalized}".`,
        remediation: 'Choose an export-capable format from list_formats.',
        retryable: false,
        location: null,
      },
    ];
  }
  const diagnostics: McpDiagnostic[] = [];
  const details = summarizeMarkdownNodes(prepared.markdownDoc);
  const { flattenBlocks } = await import('@bendyline/squisq/doc');
  const flatBlocks = flattenBlocks(prepared.doc.blocks);
  await yieldForCancellation(signal);
  if (['pptx', 'pdf', 'mp4', 'gif'].includes(normalized)) {
    let denseBlockCount = 0;
    let firstDenseBlock: PreparedDocument['doc']['blocks'][number] | null = null;
    let analyzedIndex = 0;
    for (const entry of await analyzeDocumentBlocks(prepared.doc.blocks)) {
      const checkpoint = cancellationCheckpoint(signal, analyzedIndex);
      if (checkpoint) await checkpoint;
      analyzedIndex += 1;
      if (entry.bodyWordCount <= 120 && entry.plainText.length <= 900) continue;
      denseBlockCount += 1;
      firstDenseBlock ??= entry.block;
    }
    if (denseBlockCount > 0) {
      diagnostics.push({
        code: 'content-density-high',
        severity: 'warning',
        stage: 'validate',
        format: normalized,
        count: denseBlockCount,
        message:
          denseBlockCount === 1
            ? `Block "${firstDenseBlock?.title ?? firstDenseBlock?.id ?? 'unknown'}" may be too dense for a single rendered item.`
            : `${denseBlockCount} blocks may be too dense for a single rendered item.`,
        remediation:
          'Split the block, shorten prose, or confirm the result with preview_document overflow diagnostics.',
        retryable: false,
        location:
          denseBlockCount === 1 && firstDenseBlock
            ? {
                kind: 'block',
                blockId: toWireIdentifier(firstDenseBlock.id, 'block'),
                nodeType: 'block',
              }
            : null,
      });
    }
    const denseTables = details.tables.filter(
      (table) => table.columnCount > 8 || table.rowCount > 30,
    );
    if (denseTables.length > 0) {
      const firstDenseTable = denseTables[0];
      diagnostics.push({
        code: 'table-density-high',
        severity: 'warning',
        stage: 'validate',
        format: normalized,
        count: denseTables.length,
        message:
          denseTables.length === 1 && firstDenseTable
            ? `Table ${firstDenseTable.index + 1} has ${firstDenseTable.rowCount} rows and ${firstDenseTable.columnCount} columns and may overflow.`
            : `${denseTables.length} tables may overflow the rendered output.`,
        remediation:
          'Split the table or use a spreadsheet target; verify visual clipping with preview_document.',
        retryable: false,
        location: null,
      });
    }
  }
  if (normalized === 'pptx' && flatBlocks.some((block) => block.template)) {
    diagnostics.push(
      warningDiagnostic(
        'Editable-native PPTX export preserves semantic content and theme but does not reproduce arbitrary Squisq template geometry.',
        'validate',
        normalized,
      ),
    );
  }
  if (normalized === 'pdf' && (await hasImages(prepared.markdownDoc, signal))) {
    diagnostics.push(
      warningDiagnostic(
        'Native PDF export currently represents Markdown images as labeled placeholders.',
        'validate',
        normalized,
      ),
    );
  }
  if ((normalized === 'csv' || normalized === 'xlsx') && details.tableCount === 0) {
    diagnostics.push(
      warningDiagnostic(
        `${normalized.toUpperCase()} export is table-oriented; this document contains no Markdown tables.`,
        'validate',
        normalized,
      ),
    );
  }
  if (normalized === 'gif' && (prepared.doc.audio?.segments?.length ?? 0) > 0) {
    diagnostics.push(
      warningDiagnostic(
        'Animated GIF does not support audio; audio will be omitted.',
        'validate',
        normalized,
      ),
    );
  }
  return diagnostics;
}

async function hasImages(
  markdownDoc: PreparedDocument['markdownDoc'],
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  let found = false;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== 'object') return;
    const candidate = node as { type?: unknown; children?: unknown };
    if (candidate.type === 'image' || candidate.type === 'imageReference') found = true;
    if (Array.isArray(candidate.children)) candidate.children.forEach(visit);
  };
  visit(markdownDoc);
  await yieldForCancellation(signal);
  return found;
}

export function boundDiagnostics(
  diagnostics: readonly McpDiagnostic[],
  stage: DiagnosticStage,
): McpDiagnostic[] {
  const aggregated = aggregateDiagnostics(diagnostics);
  if (aggregated.length <= MAX_DIAGNOSTICS) return aggregated;

  // Reserve room for one aggregate per severity. This preserves validation
  // occurrence counts and error status even when individual entries are omitted.
  const retained = aggregated.slice(0, MAX_DIAGNOSTICS - 3);
  const omitted = aggregated.slice(MAX_DIAGNOSTICS - 3);
  const severities: readonly DiagnosticSeverity[] = ['error', 'warning', 'info'];
  const truncationDiagnostics = severities.flatMap((severity): McpDiagnostic[] => {
    const entries = omitted.filter((diagnostic) => diagnostic.severity === severity);
    if (entries.length === 0) return [];
    const occurrenceCount = entries.reduce(
      (sum, diagnostic) => safeDiagnosticCountSum(sum, diagnostic.count),
      0,
    );
    return [
      {
        code: 'diagnostics-truncated',
        severity,
        stage,
        format: null,
        count: occurrenceCount,
        message: `${entries.length} additional ${severity} diagnostic entries were aggregated to keep the MCP result bounded.`,
        remediation:
          'Inspect a narrower document range or repair the reported issue class before validating again.',
        retryable: false,
        location: null,
      },
    ];
  });
  return [...retained, ...truncationDiagnostics];
}

function aggregateDiagnostics(diagnostics: readonly McpDiagnostic[]): McpDiagnostic[] {
  const aggregated = new Map<string, McpDiagnostic>();
  for (const input of diagnostics) {
    const diagnostic = boundDiagnosticText(input);
    const key = [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.stage,
      diagnostic.format ?? '',
      diagnostic.message,
      diagnostic.remediation ?? '',
      String(diagnostic.retryable),
    ].join('\0');
    const current = aggregated.get(key);
    if (!current) {
      aggregated.set(key, diagnostic);
      continue;
    }
    aggregated.set(key, {
      ...current,
      count: safeDiagnosticCountSum(current.count, diagnostic.count),
      location: sameLocation(current.location, diagnostic.location) ? current.location : null,
    });
  }
  return [...aggregated.values()];
}

function boundDiagnosticText(diagnostic: McpDiagnostic): McpDiagnostic {
  const normalizedFormat = diagnostic.format?.toLowerCase() ?? null;
  return {
    ...diagnostic,
    code: toWireIdentifier(diagnostic.code, 'diagnostic'),
    format:
      normalizedFormat !== null && FORMAT_PATTERN.test(normalizedFormat) ? normalizedFormat : null,
    message: boundWireText(
      diagnostic.message,
      MCP_WIRE_LIMITS.messageCharacters,
      'Document diagnostic',
    ),
    remediation:
      diagnostic.remediation === null
        ? null
        : boundWireText(diagnostic.remediation, MCP_WIRE_LIMITS.messageCharacters),
    location:
      diagnostic.location?.kind === 'block'
        ? {
            ...diagnostic.location,
            blockId: toWireIdentifier(diagnostic.location.blockId, 'block'),
            nodeType: toWireIdentifier(diagnostic.location.nodeType, 'node'),
          }
        : diagnostic.location,
  };
}

function sameLocation(left: McpDiagnostic['location'], right: McpDiagnostic['location']): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeDiagnosticCountSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function summarizeDiagnostics(diagnostics: readonly McpDiagnostic[]): {
  errorCount: number;
  warningCount: number;
  infoCount: number;
} {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') {
      errorCount = safeDiagnosticCountSum(errorCount, diagnostic.count);
    } else if (diagnostic.severity === 'warning') {
      warningCount = safeDiagnosticCountSum(warningCount, diagnostic.count);
    } else {
      infoCount = safeDiagnosticCountSum(infoCount, diagnostic.count);
    }
  }
  return { errorCount, warningCount, infoCount };
}

function normalizeTargetFormat(targetFormat: string | null): string | null {
  if (targetFormat === null) return null;
  const normalized = targetFormat.toLowerCase();
  if (!FORMAT_PATTERN.test(normalized)) {
    throw new Error(`Invalid target format "${targetFormat.slice(0, 64)}"`);
  }
  return normalized;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

async function multisetSimilarity(
  left: readonly string[],
  right: readonly string[],
  signal?: AbortSignal,
): Promise<number> {
  if (left.length === 0 && right.length === 0) return 1;
  const [leftCounts, rightCounts] = await Promise.all([
    counts(left, signal),
    counts(right, signal),
  ]);
  let intersection = 0;
  let union = 0;
  let index = 0;
  for (const word of new Set([...leftCounts.keys(), ...rightCounts.keys()])) {
    intersection += Math.min(leftCounts.get(word) ?? 0, rightCounts.get(word) ?? 0);
    union += Math.max(leftCounts.get(word) ?? 0, rightCounts.get(word) ?? 0);
    const checkpoint = cancellationCheckpoint(signal, index);
    if (checkpoint) await checkpoint;
    index += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

async function counts(
  values: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined) result.set(value, (result.get(value) ?? 0) + 1);
    const checkpoint = cancellationCheckpoint(signal, index);
    if (checkpoint) await checkpoint;
  }
  return result;
}

function ratioSimilarity(left: number, right: number): number {
  return left === 0 && right === 0 ? 1 : Math.min(left, right) / Math.max(left, right);
}

function assetSimilarity(
  left: InspectionResult['assets'],
  right: InspectionResult['assets'],
): number {
  if (left.length === 0 && right.length === 0) return 1;
  const leftKeys = new Set(left.map((asset) => `${asset.path}:${asset.sha256 ?? asset.size}`));
  const rightKeys = new Set(right.map((asset) => `${asset.path}:${asset.sha256 ?? asset.size}`));
  const intersection = [...leftKeys].filter((key) => rightKeys.has(key)).length;
  const union = new Set([...leftKeys, ...rightKeys]).size;
  return union === 0 ? 1 : intersection / union;
}

function objectSimilarity(
  left: InspectionResult['metadata'],
  right: InspectionResult['metadata'],
): number {
  const keys = ['title', 'author', 'description'] as const;
  return keys.filter((key) => left[key] === right[key]).length / keys.length;
}

function metadataFieldCount(inspection: InspectionResult): number {
  return Object.values(inspection.metadata).filter((value) => value !== null).length;
}

async function layoutTokens(prepared: PreparedDocument, signal?: AbortSignal): Promise<string[]> {
  const tokens: string[] = [];
  const pending = [...prepared.doc.blocks].reverse();
  let index = 0;
  while (pending.length > 0) {
    const block = pending.pop();
    if (!block) break;
    tokens.push(`block:${block.template ?? 'default'}`);
    const children = block.children ?? [];
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
      const child = children[childIndex];
      if (child) pending.push(child);
    }
    const checkpoint = cancellationCheckpoint(signal, index);
    if (checkpoint) await checkpoint;
    index += 1;
  }
  const customTemplates = prepared.doc.customTemplates ?? [];
  for (let templateIndex = 0; templateIndex < customTemplates.length; templateIndex += 1) {
    const template = customTemplates[templateIndex];
    if (!template) continue;
    tokens.push(`custom:${template.name}:${template.label}`);
    const checkpoint = cancellationCheckpoint(signal, index + templateIndex);
    if (checkpoint) await checkpoint;
  }
  return tokens;
}

function timingSummary(prepared: PreparedDocument): {
  duration: number;
  segmentCount: number;
  captionCount: number;
} {
  return {
    duration: prepared.doc.duration,
    segmentCount: prepared.doc.audio.segments.length,
    captionCount: prepared.doc.captions?.phrases.length ?? 0,
  };
}

async function accessibilityTokens(
  prepared: PreparedDocument,
  signal?: AbortSignal,
): Promise<string[]> {
  const tokens: string[] = [];
  const pending: unknown[] = [prepared.markdownDoc];
  let index = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const candidate = node as { type?: unknown; alt?: unknown; children?: unknown };
    if (candidate.type === 'image' || candidate.type === 'imageReference') {
      const alt = typeof candidate.alt === 'string' ? candidate.alt.trim() : '';
      tokens.push(`image-alt:${alt}`);
    }
    if (Array.isArray(candidate.children)) {
      for (let childIndex = candidate.children.length - 1; childIndex >= 0; childIndex -= 1) {
        pending.push(candidate.children[childIndex]);
      }
    }
    const checkpoint = cancellationCheckpoint(signal, index);
    if (checkpoint) await checkpoint;
    index += 1;
  }
  const phrases = prepared.doc.captions?.phrases ?? [];
  for (let phraseIndex = 0; phraseIndex < phrases.length; phraseIndex += 1) {
    const phrase = phrases[phraseIndex];
    if (!phrase) continue;
    tokens.push(`caption:${phrase.text}`);
    const checkpoint = cancellationCheckpoint(signal, index + phraseIndex);
    if (checkpoint) await checkpoint;
  }
  return tokens;
}

function cancellationCheckpoint(
  signal: AbortSignal | undefined,
  index: number,
): Promise<void> | null {
  throwIfAborted(signal);
  return index % CANCELLATION_YIELD_INTERVAL === 0 ? yieldForCancellation(signal) : null;
}

async function yieldForCancellation(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

function metric(
  name: string,
  leftValue: number,
  rightValue: number,
  similarity: number,
): ComparisonMetric {
  return { name, leftValue, rightValue, similarity: clamp01(similarity) };
}

function change(
  category: ComparisonChange['category'],
  similarity: number,
  label: string,
  leftCount: number,
  rightCount: number,
): ComparisonChange {
  const status =
    similarity === 1
      ? 'retained'
      : leftCount === 0 && rightCount > 0
        ? 'added'
        : leftCount > 0 && rightCount === 0
          ? 'omitted'
          : similarity === 0
            ? 'changed'
            : 'degraded';
  return {
    category,
    status,
    path: null,
    message: `${label} similarity is ${Math.round(similarity * 100)}%.`,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
}
