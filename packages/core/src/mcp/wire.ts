import { tryParseWorkspacePath, type WorkspacePath } from '../filesystem/workspace-path.js';
import {
  DOCBLOCKS_MCP_WIRE_VERSION,
  type AppliedOption,
  type ArtifactRef,
  type AssetSummary,
  type BlockSummary,
  type BundleAssetRef,
  type BundleAssetContentSource,
  type ComparisonChange,
  type ComparisonMetric,
  type ComparisonResult,
  type ConversionFidelity,
  type ConversionResult,
  type DiagnosticLocation,
  type DiagnosticSeverity,
  type DiagnosticStage,
  type DocumentMetadataSummary,
  type DocumentItemSummary,
  type DocumentSource,
  type DocumentStatistics,
  type EngineVersion,
  type InspectionResult,
  type LinkSummary,
  type MaterializationOptions,
  type McpDiagnostic,
  type McpErrorResult,
  type OutlineEntry,
  type PreviewItem,
  type PreviewResult,
  type SourceRange,
  type ThemeSummary,
  type TableSummary,
} from './types.js';

/** Quantitative limits for untrusted MCP payloads. */
export const MCP_WIRE_LIMITS = Object.freeze({
  identifierCharacters: 256,
  formatCharacters: 64,
  mimeTypeCharacters: 256,
  labelCharacters: 1_024,
  pathCharacters: 4_096,
  uriCharacters: 8_192,
  messageCharacters: 4_000,
  excerptCharacters: 4_096,
  documentCharacters: 20 * 1024 * 1024,
  artifactBytes: 500 * 1024 * 1024,
  bundleAssets: 256,
  arrayEntries: 10_000,
  previewItems: 1_000,
  imageDimension: 32_768,
});

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ENGINE_NAME_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9._:-]*|@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)$/u;
const FORMAT_PATTERN = /^[a-z0-9][a-z0-9.+_-]*$/u;
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function parseArtifactRef(value: unknown): ArtifactRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'uri',
      'format',
      'mimeType',
      'size',
      'sha256',
      'sourceFormat',
      'sourceSha256',
      'suggestedFilename',
      'appliedOptions',
      'engineVersions',
      'createdAt',
      'expiresAt',
    ])
  ) {
    return null;
  }

  const {
    id,
    uri,
    format,
    mimeType,
    size,
    sha256,
    sourceFormat,
    sourceSha256,
    suggestedFilename,
    createdAt,
    expiresAt,
  } = value;
  const appliedOptions = parseArray(value.appliedOptions, parseAppliedOption);
  const engineVersions = parseArray(value.engineVersions, parseEngineVersion);
  if (
    !isIdentifier(id) ||
    !isArtifactUri(uri, id) ||
    !isFormat(format) ||
    !isMimeType(mimeType) ||
    !isBoundedInteger(size, 0, MCP_WIRE_LIMITS.artifactBytes) ||
    !isSha256(sha256) ||
    !(sourceFormat === null || isFormat(sourceFormat)) ||
    !(sourceSha256 === null || isSha256(sourceSha256)) ||
    !isSafeFilename(suggestedFilename) ||
    appliedOptions === null ||
    engineVersions === null ||
    hasDuplicateNames(appliedOptions) ||
    hasDuplicateNames(engineVersions) ||
    !isIsoTimestamp(createdAt) ||
    !(expiresAt === null || isIsoTimestamp(expiresAt)) ||
    (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(createdAt))
  ) {
    return null;
  }

  return {
    id,
    uri,
    format,
    mimeType,
    size,
    sha256,
    sourceFormat,
    sourceSha256,
    suggestedFilename,
    appliedOptions,
    engineVersions,
    createdAt,
    expiresAt,
  };
}

export function parseDocumentSource(value: unknown): DocumentSource | null {
  // Flat-string convenience form, mirroring documentSourceSchema: an
  // artifact URI string is an artifact source, any other string is a
  // root-relative file path on the default (sole) read root. Kept in both
  // layers deliberately — the zod schema guards the SDK boundary, this
  // parser guards every other wire entry.
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{')) {
      try {
        return parseDocumentSource(JSON.parse(text));
      } catch {
        return null;
      }
    }
    if (isArtifactUri(text)) return { kind: 'artifact', uri: text };
    const parsedPath = parseNonRootWorkspacePath(text);
    return parsedPath === null
      ? null
      : { kind: 'file', rootId: null, path: parsedPath, format: null };
  }
  if (!isRecord(value) || typeof value.kind !== 'string') return null;

  switch (value.kind) {
    case 'markdown': {
      if (
        !hasExactKeys(value, ['kind', 'markdown']) &&
        !hasExactKeys(value, ['kind', 'markdown', 'name'])
      ) {
        return null;
      }
      const { markdown } = value;
      const name = Object.prototype.hasOwnProperty.call(value, 'name') ? value.name : null;
      if (
        !isBoundedString(markdown, MCP_WIRE_LIMITS.documentCharacters) ||
        !isNullableBoundedString(name, MCP_WIRE_LIMITS.labelCharacters)
      ) {
        return null;
      }
      return { kind: 'markdown', markdown, name };
    }
    case 'file': {
      if (
        !hasExactKeys(value, ['kind', 'rootId', 'path']) &&
        !hasExactKeys(value, ['kind', 'rootId', 'path', 'format']) &&
        !hasExactKeys(value, ['kind', 'path']) &&
        !hasExactKeys(value, ['kind', 'path', 'format'])
      ) {
        return null;
      }
      const path = value.path;
      const rootId = Object.prototype.hasOwnProperty.call(value, 'rootId') ? value.rootId : null;
      const format = Object.prototype.hasOwnProperty.call(value, 'format') ? value.format : null;
      const parsedPath = parseNonRootWorkspacePath(path);
      if (
        !(rootId === null || isIdentifier(rootId)) ||
        parsedPath === null ||
        !(format === null || isFormat(format))
      ) {
        return null;
      }
      return { kind: 'file', rootId, path: parsedPath, format };
    }
    case 'artifact': {
      if (!hasExactKeys(value, ['kind', 'uri']) || !isArtifactUri(value.uri)) return null;
      return { kind: 'artifact', uri: value.uri };
    }
    case 'bundle': {
      if (
        !hasExactKeys(value, ['kind', 'markdown', 'assets']) &&
        !hasExactKeys(value, ['kind', 'markdown', 'assets', 'name'])
      ) {
        return null;
      }
      const { markdown } = value;
      const name = Object.prototype.hasOwnProperty.call(value, 'name') ? value.name : null;
      if (
        !isBoundedString(markdown, MCP_WIRE_LIMITS.documentCharacters) ||
        !isNullableBoundedString(name, MCP_WIRE_LIMITS.labelCharacters)
      ) {
        return null;
      }
      const assets = parseArray(value.assets, parseBundleAssetRef, MCP_WIRE_LIMITS.bundleAssets);
      if (assets === null || hasDuplicatePaths(assets)) return null;
      return { kind: 'bundle', markdown, assets, name };
    }
    default:
      return null;
  }
}

export function parseMcpDiagnostic(value: unknown): McpDiagnostic | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'code',
      'severity',
      'stage',
      'format',
      'count',
      'message',
      'remediation',
      'retryable',
      'location',
    ])
  ) {
    return null;
  }

  const { code, severity, stage, format, count, message, remediation, retryable } = value;
  const location = parseNullable(value.location, parseDiagnosticLocation);
  if (
    !isIdentifier(code) ||
    !isDiagnosticSeverity(severity) ||
    !isDiagnosticStage(stage) ||
    !(format === null || isFormat(format)) ||
    !isBoundedInteger(count, 1, Number.MAX_SAFE_INTEGER) ||
    !isBoundedString(message, MCP_WIRE_LIMITS.messageCharacters, 1) ||
    !isNullableBoundedString(remediation, MCP_WIRE_LIMITS.messageCharacters) ||
    typeof retryable !== 'boolean' ||
    location === undefined
  ) {
    return null;
  }

  return {
    code,
    severity,
    stage,
    format,
    count,
    message,
    remediation,
    retryable,
    location,
  };
}

export function parseMcpErrorResult(value: unknown): McpErrorResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'kind', 'result', 'error']) ||
    value.version !== DOCBLOCKS_MCP_WIRE_VERSION ||
    value.kind !== 'error' ||
    value.result !== null ||
    !isRecord(value.error) ||
    !hasExactKeys(value.error, [
      'code',
      'message',
      'stage',
      'format',
      'hint',
      'retryable',
      'operationLoad',
    ])
  ) {
    return null;
  }
  const { code, message, stage, format, hint, retryable, operationLoad } = value.error;
  if (
    !isIdentifier(code) ||
    !isBoundedString(message, MCP_WIRE_LIMITS.messageCharacters, 1) ||
    !(stage === null || isDiagnosticStage(stage)) ||
    !(format === null || isFormat(format)) ||
    !isNullableBoundedString(hint, MCP_WIRE_LIMITS.messageCharacters) ||
    typeof retryable !== 'boolean' ||
    !(
      operationLoad === null ||
      (isRecord(operationLoad) &&
        hasExactKeys(operationLoad, ['active', 'capacity']) &&
        isBoundedInteger(operationLoad.active, 0, 32) &&
        isBoundedInteger(operationLoad.capacity, 1, 32) &&
        operationLoad.active <= operationLoad.capacity)
    )
  ) {
    return null;
  }
  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'error',
    result: null,
    error: {
      code,
      message,
      stage,
      format,
      hint,
      retryable,
      operationLoad:
        operationLoad === null
          ? null
          : {
              active: operationLoad.active as number,
              capacity: operationLoad.capacity as number,
            },
    },
  };
}

export function parseConversionResult(value: unknown): ConversionResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'kind',
      'sourceFormat',
      'targetFormat',
      'artifact',
      'fidelity',
      'appliedThemeId',
      'appliedTransformId',
      'sourceAssets',
      'sourceAssetCount',
      'diagnostics',
    ]) ||
    value.version !== DOCBLOCKS_MCP_WIRE_VERSION ||
    value.kind !== 'conversion' ||
    !isFormat(value.sourceFormat) ||
    !isFormat(value.targetFormat) ||
    !isConversionFidelity(value.fidelity) ||
    !isNullableIdentifier(value.appliedThemeId) ||
    !isNullableIdentifier(value.appliedTransformId) ||
    !isBoundedInteger(value.sourceAssetCount, 0, MCP_WIRE_LIMITS.arrayEntries)
  ) {
    return null;
  }

  const artifact = parseArtifactRef(value.artifact);
  const sourceAssets = parseArray(value.sourceAssets, parseAssetSummary);
  const diagnostics = parseArray(value.diagnostics, parseMcpDiagnostic);
  if (
    artifact === null ||
    sourceAssets === null ||
    diagnostics === null ||
    sourceAssets.length !== value.sourceAssetCount ||
    hasDuplicatePaths(sourceAssets) ||
    artifact.format !== value.targetFormat ||
    (artifact.sourceFormat !== null && artifact.sourceFormat !== value.sourceFormat)
  ) {
    return null;
  }

  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'conversion',
    sourceFormat: value.sourceFormat,
    targetFormat: value.targetFormat,
    artifact,
    fidelity: value.fidelity,
    appliedThemeId: value.appliedThemeId,
    appliedTransformId: value.appliedTransformId,
    sourceAssets,
    sourceAssetCount: value.sourceAssetCount,
    diagnostics,
  };
}

export function parseInspectionResult(value: unknown): InspectionResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'kind',
      'sourceFormat',
      'metadata',
      'statistics',
      'outline',
      'blocks',
      'blockOffset',
      'nextCursor',
      'tables',
      'links',
      'items',
      'assets',
      'theme',
      'truncated',
      'detailsTruncated',
      'diagnostics',
    ]) ||
    value.version !== DOCBLOCKS_MCP_WIRE_VERSION ||
    value.kind !== 'inspection' ||
    !isFormat(value.sourceFormat) ||
    !isBoundedInteger(value.blockOffset, 0, MCP_WIRE_LIMITS.arrayEntries) ||
    !isNullableBoundedString(value.nextCursor, MCP_WIRE_LIMITS.identifierCharacters) ||
    typeof value.truncated !== 'boolean' ||
    typeof value.detailsTruncated !== 'boolean'
  ) {
    return null;
  }

  const metadata = parseDocumentMetadata(value.metadata);
  const statistics = parseDocumentStatistics(value.statistics);
  const outline = parseArray(value.outline, parseOutlineEntry);
  const blocks = parseArray(value.blocks, parseBlockSummary);
  const tables = parseArray(value.tables, parseTableSummary);
  const links = parseArray(value.links, parseLinkSummary);
  const items = parseArray(value.items, parseDocumentItemSummary);
  const assets = parseArray(value.assets, parseAssetSummary);
  const theme = parseNullable(value.theme, parseThemeSummary);
  const diagnostics = parseArray(value.diagnostics, parseMcpDiagnostic);
  if (
    metadata === null ||
    statistics === null ||
    outline === null ||
    blocks === null ||
    tables === null ||
    links === null ||
    items === null ||
    assets === null ||
    theme === undefined ||
    diagnostics === null ||
    statistics.blockCount < value.blockOffset + blocks.length ||
    statistics.assetCount < assets.length ||
    (!value.truncated && statistics.blockCount !== value.blockOffset + blocks.length) ||
    value.truncated !== (value.nextCursor !== null) ||
    statistics.tableCount < tables.length ||
    statistics.linkCount < links.length ||
    hasDuplicateIds(outline) ||
    hasDuplicateIds(blocks) ||
    hasDuplicateIndexes(tables) ||
    hasDuplicateIndexes(links) ||
    hasDuplicateItemIndexes(items) ||
    hasDuplicatePaths(assets) ||
    outline.some((entry) => entry.blockIndex >= statistics.blockCount) ||
    blocks.some(
      (block) => block.sourceRange !== null && block.sourceRange.end > statistics.characterCount,
    )
  ) {
    return null;
  }

  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'inspection',
    sourceFormat: value.sourceFormat,
    metadata,
    statistics,
    outline,
    blocks,
    blockOffset: value.blockOffset,
    nextCursor: value.nextCursor,
    tables,
    links,
    items,
    assets,
    theme,
    truncated: value.truncated,
    detailsTruncated: value.detailsTruncated,
    diagnostics,
  };
}

export function parsePreviewResult(value: unknown): PreviewResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'kind',
      'sourceFormat',
      'previewBasis',
      'totalItems',
      'items',
      'truncated',
      'diagnostics',
    ]) ||
    value.version !== DOCBLOCKS_MCP_WIRE_VERSION ||
    value.kind !== 'preview' ||
    !isFormat(value.sourceFormat) ||
    !(
      value.previewBasis === 'source-render' ||
      value.previewBasis === 'reconstructed-import' ||
      value.previewBasis === 'native-extracted'
    ) ||
    !isBoundedInteger(value.totalItems, 0, Number.MAX_SAFE_INTEGER) ||
    typeof value.truncated !== 'boolean'
  ) {
    return null;
  }

  const items = parseArray(value.items, parsePreviewItem, MCP_WIRE_LIMITS.previewItems);
  const diagnostics = parseArray(value.diagnostics, parseMcpDiagnostic);
  if (
    items === null ||
    diagnostics === null ||
    value.totalItems < items.length ||
    (!value.truncated && value.totalItems !== items.length) ||
    hasDuplicatePreviewIndexes(items) ||
    items.some(
      (item) =>
        item.artifact.sourceFormat !== null && item.artifact.sourceFormat !== value.sourceFormat,
    )
  ) {
    return null;
  }

  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'preview',
    sourceFormat: value.sourceFormat,
    previewBasis: value.previewBasis,
    totalItems: value.totalItems,
    items,
    truncated: value.truncated,
    diagnostics,
  };
}

export function parseComparisonResult(value: unknown): ComparisonResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'kind',
      'leftFormat',
      'rightFormat',
      'equivalent',
      'score',
      'changes',
      'metrics',
      'diagnostics',
    ]) ||
    value.version !== DOCBLOCKS_MCP_WIRE_VERSION ||
    value.kind !== 'comparison' ||
    !isFormat(value.leftFormat) ||
    !isFormat(value.rightFormat) ||
    typeof value.equivalent !== 'boolean' ||
    !isBoundedNumber(value.score, 0, 1)
  ) {
    return null;
  }

  const changes = parseArray(value.changes, parseComparisonChange);
  const metrics = parseArray(value.metrics, parseComparisonMetric);
  const diagnostics = parseArray(value.diagnostics, parseMcpDiagnostic);
  if (
    changes === null ||
    metrics === null ||
    diagnostics === null ||
    hasDuplicateNames(metrics) ||
    (value.equivalent &&
      (value.score !== 1 || changes.some((change) => change.status !== 'retained')))
  ) {
    return null;
  }

  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'comparison',
    leftFormat: value.leftFormat,
    rightFormat: value.rightFormat,
    equivalent: value.equivalent,
    score: value.score,
    changes,
    metrics,
    diagnostics,
  };
}

export function parseMaterializationOptions(value: unknown): MaterializationOptions | null {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, ['rootId', 'path', 'ifExists']) &&
      !hasExactKeys(value, ['rootId', 'path', 'ifExists', 'expectedSha256'])) ||
    !isIdentifier(value.rootId)
  ) {
    return null;
  }
  const path = parseNonRootWorkspacePath(value.path);
  if (path === null) return null;

  if (
    value.ifExists === 'error' &&
    (value.expectedSha256 === null ||
      !Object.prototype.hasOwnProperty.call(value, 'expectedSha256'))
  ) {
    return { rootId: value.rootId, path, ifExists: 'error', expectedSha256: null };
  }
  if (value.ifExists === 'replace' && isSha256(value.expectedSha256)) {
    return {
      rootId: value.rootId,
      path,
      ifExists: 'replace',
      expectedSha256: value.expectedSha256,
    };
  }
  return null;
}

function parseBundleAssetRef(value: unknown): BundleAssetRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['path', 'source', 'mimeType', 'altText', 'credit', 'license'])
  ) {
    return null;
  }
  const path = parseNonRootWorkspacePath(value.path);
  const source = parseBundleAssetContentSource(value.source);
  if (
    path === null ||
    source === null ||
    !(value.mimeType === null || isMimeType(value.mimeType)) ||
    !isNullableBoundedString(value.altText, MCP_WIRE_LIMITS.labelCharacters) ||
    !isNullableBoundedString(value.credit, MCP_WIRE_LIMITS.labelCharacters) ||
    !isNullableBoundedString(value.license, MCP_WIRE_LIMITS.labelCharacters)
  ) {
    return null;
  }
  return {
    path,
    source,
    mimeType: value.mimeType,
    altText: value.altText,
    credit: value.credit,
    license: value.license,
  };
}

function parseBundleAssetContentSource(value: unknown): BundleAssetContentSource | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'file') {
    if (!hasExactKeys(value, ['kind', 'rootId', 'path']) || !isIdentifier(value.rootId)) {
      return null;
    }
    const path = parseNonRootWorkspacePath(value.path);
    return path === null ? null : { kind: 'file', rootId: value.rootId, path };
  }
  if (value.kind === 'artifact') {
    return hasExactKeys(value, ['kind', 'uri']) && isArtifactUri(value.uri)
      ? { kind: 'artifact', uri: value.uri }
      : null;
  }
  return null;
}

function parseDiagnosticLocation(value: unknown): DiagnosticLocation | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'source':
      return hasExactKeys(value, ['kind', 'line', 'column']) &&
        isBoundedInteger(value.line, 1, Number.MAX_SAFE_INTEGER) &&
        isBoundedInteger(value.column, 1, Number.MAX_SAFE_INTEGER)
        ? { kind: 'source', line: value.line, column: value.column }
        : null;
    case 'block':
      return hasExactKeys(value, ['kind', 'blockId', 'nodeType']) &&
        isIdentifier(value.blockId) &&
        isIdentifier(value.nodeType)
        ? { kind: 'block', blockId: value.blockId, nodeType: value.nodeType }
        : null;
    case 'asset': {
      if (!hasExactKeys(value, ['kind', 'path'])) return null;
      const path = parseNonRootWorkspacePath(value.path);
      return path === null ? null : { kind: 'asset', path };
    }
    case 'item':
      return hasExactKeys(value, ['kind', 'itemKind', 'index']) &&
        isPreviewItemKind(value.itemKind) &&
        isBoundedInteger(value.index, 0, Number.MAX_SAFE_INTEGER)
        ? { kind: 'item', itemKind: value.itemKind, index: value.index }
        : null;
    default:
      return null;
  }
}

function parseAppliedOption(value: unknown): AppliedOption | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['name', 'value']) ||
    !isIdentifier(value.name) ||
    !isAppliedOptionValue(value.value)
  ) {
    return null;
  }
  return { name: value.name, value: value.value };
}

function parseEngineVersion(value: unknown): EngineVersion | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['name', 'version']) ||
    !isEngineName(value.name) ||
    !isBoundedString(value.version, MCP_WIRE_LIMITS.identifierCharacters, 1)
  ) {
    return null;
  }
  return { name: value.name, version: value.version };
}

function parseDocumentMetadata(value: unknown): DocumentMetadataSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['title', 'author', 'description']) ||
    !isNullableBoundedString(value.title, MCP_WIRE_LIMITS.labelCharacters) ||
    !isNullableBoundedString(value.author, MCP_WIRE_LIMITS.labelCharacters) ||
    !isNullableBoundedString(value.description, MCP_WIRE_LIMITS.messageCharacters)
  ) {
    return null;
  }
  return { title: value.title, author: value.author, description: value.description };
}

function parseDocumentStatistics(value: unknown): DocumentStatistics | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'blockCount',
      'wordCount',
      'characterCount',
      'tableCount',
      'linkCount',
      'assetCount',
      'pageCount',
      'slideCount',
      'sheetCount',
    ]) ||
    !isNonNegativeInteger(value.blockCount) ||
    !isNonNegativeInteger(value.wordCount) ||
    !isNonNegativeInteger(value.characterCount) ||
    !isNonNegativeInteger(value.tableCount) ||
    !isNonNegativeInteger(value.linkCount) ||
    !isNonNegativeInteger(value.assetCount) ||
    !isNullableNonNegativeInteger(value.pageCount) ||
    !isNullableNonNegativeInteger(value.slideCount) ||
    !isNullableNonNegativeInteger(value.sheetCount)
  ) {
    return null;
  }
  return {
    blockCount: value.blockCount,
    wordCount: value.wordCount,
    characterCount: value.characterCount,
    tableCount: value.tableCount,
    linkCount: value.linkCount,
    assetCount: value.assetCount,
    pageCount: value.pageCount,
    slideCount: value.slideCount,
    sheetCount: value.sheetCount,
  };
}

function parseOutlineEntry(value: unknown): OutlineEntry | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'title', 'level', 'blockIndex']) ||
    !isIdentifier(value.id) ||
    !isBoundedString(value.title, MCP_WIRE_LIMITS.labelCharacters, 1) ||
    !isBoundedInteger(value.level, 1, 6) ||
    !isNonNegativeInteger(value.blockIndex)
  ) {
    return null;
  }
  return { id: value.id, title: value.title, level: value.level, blockIndex: value.blockIndex };
}

function parseBlockSummary(value: unknown): BlockSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'type', 'text', 'wordCount', 'templateId', 'sourceRange']) ||
    !isIdentifier(value.id) ||
    !isIdentifier(value.type) ||
    !isBoundedString(value.text, MCP_WIRE_LIMITS.excerptCharacters) ||
    !isNonNegativeInteger(value.wordCount) ||
    !isNullableIdentifier(value.templateId)
  ) {
    return null;
  }
  const sourceRange = parseNullable(value.sourceRange, parseSourceRange);
  if (sourceRange === undefined) return null;
  return {
    id: value.id,
    type: value.type,
    text: value.text,
    wordCount: value.wordCount,
    templateId: value.templateId,
    sourceRange,
  };
}

function parseSourceRange(value: unknown): SourceRange | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['start', 'end']) ||
    !isNonNegativeInteger(value.start) ||
    !isNonNegativeInteger(value.end) ||
    value.end < value.start
  ) {
    return null;
  }
  return { start: value.start, end: value.end };
}

function parseTableSummary(value: unknown): TableSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['index', 'rowCount', 'columnCount', 'headers']) ||
    !isNonNegativeInteger(value.index) ||
    !isNonNegativeInteger(value.rowCount) ||
    !isNonNegativeInteger(value.columnCount)
  ) {
    return null;
  }
  const headers = parseArray(value.headers, (entry) =>
    isBoundedString(entry, MCP_WIRE_LIMITS.labelCharacters) ? entry : null,
  );
  if (headers === null || headers.length > value.columnCount) return null;
  return {
    index: value.index,
    rowCount: value.rowCount,
    columnCount: value.columnCount,
    headers,
  };
}

function parseLinkSummary(value: unknown): LinkSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['index', 'text', 'target']) ||
    !isNonNegativeInteger(value.index) ||
    !isBoundedString(value.text, MCP_WIRE_LIMITS.labelCharacters) ||
    !isBoundedString(value.target, MCP_WIRE_LIMITS.uriCharacters, 1)
  ) {
    return null;
  }
  return { index: value.index, text: value.text, target: value.target };
}

function parseDocumentItemSummary(value: unknown): DocumentItemSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'index', 'label', 'blockIds']) ||
    !isPreviewItemKind(value.kind) ||
    !isNonNegativeInteger(value.index) ||
    !isNullableBoundedString(value.label, MCP_WIRE_LIMITS.labelCharacters)
  ) {
    return null;
  }
  const blockIds = parseArray(value.blockIds, (entry) => (isIdentifier(entry) ? entry : null));
  if (blockIds === null || new Set(blockIds).size !== blockIds.length) return null;
  return { kind: value.kind, index: value.index, label: value.label, blockIds };
}

function parseAssetSummary(value: unknown): AssetSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['path', 'mimeType', 'size', 'sha256', 'altText', 'credit', 'license'])
  ) {
    return null;
  }
  const path = parseNonRootWorkspacePath(value.path);
  if (
    path === null ||
    !isMimeType(value.mimeType) ||
    !isBoundedInteger(value.size, 0, MCP_WIRE_LIMITS.artifactBytes) ||
    !(value.sha256 === null || isSha256(value.sha256)) ||
    !isNullableBoundedString(value.altText, MCP_WIRE_LIMITS.labelCharacters) ||
    !isNullableBoundedString(value.credit, MCP_WIRE_LIMITS.labelCharacters) ||
    !isNullableBoundedString(value.license, MCP_WIRE_LIMITS.labelCharacters)
  ) {
    return null;
  }
  return {
    path,
    mimeType: value.mimeType,
    size: value.size,
    sha256: value.sha256,
    altText: value.altText,
    credit: value.credit,
    license: value.license,
  };
}

function parseThemeSummary(value: unknown): ThemeSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'name', 'source', 'layouts']) ||
    !isIdentifier(value.id) ||
    !isBoundedString(value.name, MCP_WIRE_LIMITS.labelCharacters, 1) ||
    !(value.source === 'built-in' || value.source === 'document' || value.source === 'inferred')
  ) {
    return null;
  }
  const layouts = parseStringArray(value.layouts, MCP_WIRE_LIMITS.labelCharacters);
  if (layouts === null || new Set(layouts).size !== layouts.length) return null;
  return { id: value.id, name: value.name, source: value.source, layouts };
}

function parsePreviewItem(value: unknown): PreviewItem | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'index', 'label', 'artifact', 'width', 'height']) ||
    !isPreviewItemKind(value.kind) ||
    !isNonNegativeInteger(value.index) ||
    !isNullableBoundedString(value.label, MCP_WIRE_LIMITS.labelCharacters) ||
    !isBoundedInteger(value.width, 1, MCP_WIRE_LIMITS.imageDimension) ||
    !isBoundedInteger(value.height, 1, MCP_WIRE_LIMITS.imageDimension)
  ) {
    return null;
  }
  const artifact = parseArtifactRef(value.artifact);
  if (artifact === null || !artifact.mimeType.startsWith('image/')) return null;
  return {
    kind: value.kind,
    index: value.index,
    label: value.label,
    artifact,
    width: value.width,
    height: value.height,
  };
}

function parseComparisonChange(value: unknown): ComparisonChange | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['category', 'status', 'path', 'message']) ||
    !isComparisonCategory(value.category) ||
    !isComparisonStatus(value.status) ||
    !isNullableBoundedString(value.path, MCP_WIRE_LIMITS.pathCharacters) ||
    !isBoundedString(value.message, MCP_WIRE_LIMITS.messageCharacters, 1)
  ) {
    return null;
  }
  return {
    category: value.category,
    status: value.status,
    path: value.path,
    message: value.message,
  };
}

function parseComparisonMetric(value: unknown): ComparisonMetric | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['name', 'leftValue', 'rightValue', 'similarity']) ||
    !isIdentifier(value.name) ||
    !isFiniteNumber(value.leftValue) ||
    !isFiniteNumber(value.rightValue) ||
    !isBoundedNumber(value.similarity, 0, 1)
  ) {
    return null;
  }
  return {
    name: value.name,
    leftValue: value.leftValue,
    rightValue: value.rightValue,
    similarity: value.similarity,
  };
}

function parseArray<T>(
  value: unknown,
  parser: (entry: unknown) => T | null,
  maximumEntries: number = MCP_WIRE_LIMITS.arrayEntries,
): T[] | null {
  if (!Array.isArray(value) || value.length > maximumEntries) return null;
  const parsed: T[] = [];
  for (const entry of value) {
    const result = parser(entry);
    if (result === null) return null;
    parsed.push(result);
  }
  return parsed;
}

function parseStringArray(value: unknown, maximumCharacters: number): string[] | null {
  if (!Array.isArray(value) || value.length > MCP_WIRE_LIMITS.arrayEntries) return null;
  const parsed: string[] = [];
  for (const entry of value) {
    if (!isBoundedString(entry, maximumCharacters, 1)) return null;
    parsed.push(entry);
  }
  return parsed;
}

function parseNullable<T>(
  value: unknown,
  parser: (entry: unknown) => T | null,
): T | null | undefined {
  if (value === null) return null;
  return parser(value) ?? undefined;
}

function parseNonRootWorkspacePath(value: unknown): WorkspacePath | null {
  if (
    !isBoundedString(value, MCP_WIRE_LIMITS.pathCharacters, 1) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('//')
  ) {
    return null;
  }
  const parsed = tryParseWorkspacePath(value);
  return parsed !== null && parsed !== '' && parsed === value ? parsed : null;
}

function isArtifactUri(value: unknown, expectedId?: string): value is string {
  if (!isBoundedString(value, MCP_WIRE_LIMITS.uriCharacters, 1)) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'docblocks:' ||
      url.hostname !== 'artifacts' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return false;
    }
    const id = url.pathname.slice(1);
    return (
      !id.includes('/') &&
      isIdentifier(id) &&
      value === `docblocks://artifacts/${id}` &&
      (expectedId === undefined || id === expectedId)
    );
  } catch {
    return false;
  }
}

function isSafeFilename(value: unknown): value is string {
  return (
    isBoundedString(value, MCP_WIRE_LIMITS.labelCharacters, 1) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isIdentifier(value: unknown): value is string {
  return (
    isBoundedString(value, MCP_WIRE_LIMITS.identifierCharacters, 1) &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isEngineName(value: unknown): value is string {
  return (
    isBoundedString(value, MCP_WIRE_LIMITS.identifierCharacters, 1) &&
    ENGINE_NAME_PATTERN.test(value)
  );
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isFormat(value: unknown): value is string {
  return isBoundedString(value, MCP_WIRE_LIMITS.formatCharacters, 1) && FORMAT_PATTERN.test(value);
}

function isMimeType(value: unknown): value is string {
  return (
    isBoundedString(value, MCP_WIRE_LIMITS.mimeTypeCharacters, 3) && MIME_TYPE_PATTERN.test(value)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isAppliedOptionValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'boolean' ||
    isBoundedString(value, MCP_WIRE_LIMITS.messageCharacters) ||
    isFiniteNumber(value)
  );
}

function isDiagnosticSeverity(value: unknown): value is DiagnosticSeverity {
  return value === 'info' || value === 'warning' || value === 'error';
}

function isDiagnosticStage(value: unknown): value is DiagnosticStage {
  return (
    value === 'resolve' ||
    value === 'import' ||
    value === 'parse' ||
    value === 'inspect' ||
    value === 'transform' ||
    value === 'convert' ||
    value === 'render' ||
    value === 'export' ||
    value === 'materialize' ||
    value === 'compare'
  );
}

function isConversionFidelity(value: unknown): value is ConversionFidelity {
  return (
    value === 'semantic' ||
    value === 'editable-native' ||
    value === 'rendered-fidelity' ||
    value === 'hybrid'
  );
}

function isPreviewItemKind(value: unknown): value is PreviewItem['kind'] {
  return value === 'page' || value === 'slide' || value === 'sheet' || value === 'frame';
}

function isComparisonCategory(value: unknown): value is ComparisonChange['category'] {
  return (
    value === 'text' ||
    value === 'structure' ||
    value === 'table' ||
    value === 'media' ||
    value === 'theme' ||
    value === 'layout' ||
    value === 'metadata' ||
    value === 'timing' ||
    value === 'accessibility'
  );
}

function isComparisonStatus(value: unknown): value is ComparisonChange['status'] {
  return (
    value === 'retained' ||
    value === 'changed' ||
    value === 'degraded' ||
    value === 'omitted' ||
    value === 'added'
  );
}

function hasDuplicateNames(values: readonly { readonly name: string }[]): boolean {
  return new Set(values.map((value) => value.name)).size !== values.length;
}

function hasDuplicateIds(values: readonly { readonly id: string }[]): boolean {
  return new Set(values.map((value) => value.id)).size !== values.length;
}

function hasDuplicatePaths(values: readonly { readonly path: WorkspacePath }[]): boolean {
  return new Set(values.map((value) => value.path)).size !== values.length;
}

function hasDuplicateIndexes(values: readonly { readonly index: number }[]): boolean {
  return new Set(values.map((value) => value.index)).size !== values.length;
}

function hasDuplicateItemIndexes(values: readonly DocumentItemSummary[]): boolean {
  return new Set(values.map((value) => `${value.kind}:${value.index}`)).size !== values.length;
}

function hasDuplicatePreviewIndexes(values: readonly PreviewItem[]): boolean {
  const keys = values.map((value) => `${value.kind}:${value.index}`);
  return new Set(keys).size !== keys.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isBoundedString(
  value: unknown,
  maximumCharacters: number,
  minimumCharacters = 0,
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minimumCharacters &&
    value.length <= maximumCharacters &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0 || codePoint === 0x7f;
    })
  );
}

function isNullableBoundedString(
  value: unknown,
  maximumCharacters: number,
): value is string | null {
  return value === null || isBoundedString(value, maximumCharacters);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return isFiniteNumber(value) && value >= minimum && value <= maximum;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && typeof value === 'number' && value >= minimum && value <= maximum
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return isBoundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}
