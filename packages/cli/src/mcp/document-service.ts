import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import type {
  AssetSummary,
  BundleAssetRef,
  DocumentSource,
  McpDiagnostic,
} from '@bendyline/docblocks/mcp';
import { MCP_WIRE_LIMITS } from '@bendyline/docblocks/mcp';
import { tryParseWorkspacePath } from '@bendyline/docblocks/filesystem';
import type { MarkdownDocument } from '@bendyline/squisq/markdown';
import type { Doc } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { ConvertSource, FormatRegistry } from '@bendyline/squisq-cli/api';
import { ArtifactStore } from './artifact-store.js';
import { McpFileAuthority } from './authority.js';
import { boundWireText, isWireText } from './output-bounds.js';

const MAX_BUNDLE_ASSETS = 256;
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_ASSET_MANIFEST_BYTES = 1024 * 1024;
const MAX_METADATA_CHARACTERS = MCP_WIRE_LIMITS.labelCharacters;
const ASSET_MANIFEST_PATH = '.docblocks/assets.json';
export const MCP_ARCHIVE_LIMITS = {
  maxEntries: 2_048,
  maxEntryUncompressedBytes: MAX_BUNDLE_BYTES,
  maxUncompressedBytes: MAX_BUNDLE_BYTES,
  maxCompressionRatio: 1_000,
} as const;

export interface PreparedDocument {
  markdown: string;
  markdownDoc: MarkdownDocument;
  doc: Doc;
  container: ContentContainer;
  baseName: string;
  sourceFormat: string;
  sourceSha256: string;
  assets: AssetSummary[];
  diagnostics: McpDiagnostic[];
}

interface ResolvedSource {
  source: ConvertSource;
  sourceFormat: string;
  sourceSha256: string;
  baseName: string;
  container?: ContentContainer;
  markdown?: string;
}

/** Authority-aware normalization shared by every artifact-native MCP tool. */
export class DocumentService {
  public constructor(
    private readonly authority: McpFileAuthority,
    private readonly artifacts: ArtifactStore,
    private readonly registry?: FormatRegistry,
  ) {}

  public async prepare(source: DocumentSource, signal?: AbortSignal): Promise<PreparedDocument> {
    throwIfAborted(signal);
    const resolved = await this.resolve(source, signal);
    throwIfAborted(signal);

    let markdown = resolved.markdown;
    let container = resolved.container;
    const diagnostics: McpDiagnostic[] = [];
    if (markdown === undefined || container === undefined) {
      const { convert } = await import('@bendyline/squisq-cli/api');
      const converted = await convert(resolved.source, 'dbk', {
        signal,
        registry: this.registry,
        from: resolved.sourceFormat === 'auto' ? undefined : resolved.sourceFormat,
        formatOptions: {
          dbk: { ...MCP_ARCHIVE_LIMITS, compression: 'STORE' },
          docx: MCP_ARCHIVE_LIMITS,
          pptx: MCP_ARCHIVE_LIMITS,
          xlsx: MCP_ARCHIVE_LIMITS,
        },
      });
      diagnostics.push(
        ...converted.warnings.map((warning) => warningDiagnostic(warning, 'import')),
      );
      throwIfAborted(signal);
      const { zipToContainer } = await import('@bendyline/squisq-formats/container');
      container = await zipToContainer(converted.bytes, MCP_ARCHIVE_LIMITS);
      const importedMarkdown = await container.readDocument();
      if (importedMarkdown === null) throw new Error('Imported document did not contain Markdown');
      markdown = importedMarkdown;
    }

    const { parseMarkdown } = await import('@bendyline/squisq/markdown');
    const { markdownToDoc } = await import('@bendyline/squisq/doc');
    const markdownDoc = parseMarkdown(markdown);
    const doc = markdownToDoc(markdownDoc);
    const assets = await this.assetSummaries(container, signal);
    throwIfAborted(signal);
    return {
      markdown,
      markdownDoc,
      doc,
      container,
      baseName: resolved.baseName,
      sourceFormat: resolved.sourceFormat,
      sourceSha256: resolved.sourceSha256,
      assets,
      diagnostics,
    };
  }

  public async readBinarySource(
    source: DocumentSource,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; filename: string; format: string; sha256: string }> {
    throwIfAborted(signal);
    if (source.kind === 'file') {
      const physical = await this.authority.authorizeRootRead(source.rootId, source.path);
      const bytes = await this.authority.readFile(physical, signal);
      throwIfAborted(signal);
      const filename = basename(source.path);
      return {
        bytes,
        filename,
        format: normalizeFormat(source.format ?? formatFromName(filename)),
        sha256: sha256(bytes),
      };
    }
    if (source.kind === 'artifact') {
      const ref = await this.artifacts.get(source.uri, signal);
      throwIfAborted(signal);
      const bytes = await this.artifacts.read(source.uri, signal);
      throwIfAborted(signal);
      return {
        bytes,
        filename: ref.suggestedFilename,
        format: normalizeFormat(ref.format),
        sha256: ref.sha256,
      };
    }
    throw new Error('This operation requires a file or artifact source');
  }

  public async assetSummaries(
    container: ContentContainer,
    signal?: AbortSignal,
  ): Promise<AssetSummary[]> {
    throwIfAborted(signal);
    const entries = await container.listFiles();
    const manifest = await readAssetManifest(container, signal);
    const assets: AssetSummary[] = [];
    for (const entry of entries) {
      throwIfAborted(signal);
      if (
        entry.mimeType === 'text/markdown' ||
        entry.path === 'index.md' ||
        entry.path === ASSET_MANIFEST_PATH
      ) {
        continue;
      }
      const bytes = await container.readFile(entry.path);
      throwIfAborted(signal);
      if (!bytes) continue;
      const metadata = manifest.get(entry.path);
      assets.push({
        path: entry.path as AssetSummary['path'],
        mimeType: metadata?.mimeType ?? entry.mimeType,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
        altText: metadata?.altText ?? null,
        credit: metadata?.credit ?? null,
        license: metadata?.license ?? null,
      });
    }
    return assets.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async resolve(source: DocumentSource, signal?: AbortSignal): Promise<ResolvedSource> {
    switch (source.kind) {
      case 'markdown':
        return this.resolveMarkdown(source.markdown, source.name);
      case 'bundle':
        return this.resolveBundle(source.markdown, source.name, source.assets, signal);
      case 'file': {
        const physical = await this.authority.authorizeRootRead(source.rootId, source.path);
        const bytes = await this.authority.readFile(physical, signal);
        const name = basename(source.path);
        return {
          source: { kind: 'bytes', data: bytes, filename: name },
          sourceFormat: normalizeFormat(source.format ?? formatFromName(name)),
          sourceSha256: sha256(bytes),
          baseName: baseNameFromName(name),
        };
      }
      case 'artifact': {
        const ref = await this.artifacts.get(source.uri, signal);
        const bytes = await this.artifacts.read(source.uri, signal);
        return {
          source: { kind: 'bytes', data: bytes, filename: ref.suggestedFilename },
          sourceFormat: normalizeFormat(ref.format),
          sourceSha256: ref.sha256,
          baseName: baseNameFromName(ref.suggestedFilename),
        };
      }
    }
  }

  private async resolveMarkdown(markdown: string, name: string | null): Promise<ResolvedSource> {
    const { MemoryContentContainer } = await import('@bendyline/squisq/storage');
    const container = new MemoryContentContainer();
    await container.writeDocument(markdown);
    return {
      source: {
        kind: 'markdown',
        markdown,
        container,
        baseName: baseNameFromName(name ?? 'document.md'),
      },
      sourceFormat: 'md',
      sourceSha256: sha256(Buffer.from(markdown, 'utf8')),
      baseName: baseNameFromName(name ?? 'document.md'),
      container,
      markdown,
    };
  }

  private async resolveBundle(
    markdown: string,
    name: string | null,
    assets: readonly BundleAssetRef[],
    signal?: AbortSignal,
  ): Promise<ResolvedSource> {
    if (assets.length > MAX_BUNDLE_ASSETS) throw new Error('MCP bundle has too many assets');
    const { MemoryContentContainer } = await import('@bendyline/squisq/storage');
    const container = new MemoryContentContainer();
    await container.writeDocument(markdown);
    const hash = createHash('sha256').update(markdown, 'utf8');
    const paths = new Set<string>();
    const manifest: AssetManifestEntry[] = [];
    let totalBytes = 0;
    for (const asset of [...assets].sort((left, right) => left.path.localeCompare(right.path))) {
      throwIfAborted(signal);
      if (
        !asset.path ||
        asset.path === 'index.md' ||
        asset.path.startsWith('.docblocks/') ||
        paths.has(asset.path)
      ) {
        throw new Error('MCP bundle asset path is reserved or duplicated');
      }
      paths.add(asset.path);
      const bytes = await this.resolveAsset(asset, signal);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_BUNDLE_BYTES) throw new Error('MCP bundle assets exceed the byte limit');
      await container.writeFile(asset.path, bytes, asset.mimeType ?? undefined);
      hash.update(asset.path, 'utf8').update(bytes);
      manifest.push({
        path: asset.path,
        mimeType: asset.mimeType,
        altText: asset.altText,
        credit: asset.credit,
        license: asset.license,
      });
    }
    if (manifest.length > 0) {
      await container.writeFile(
        ASSET_MANIFEST_PATH,
        Buffer.from(JSON.stringify({ version: 1, assets: manifest }), 'utf8'),
        'application/json',
      );
    }
    const baseName = baseNameFromName(name ?? 'document.md');
    return {
      source: { kind: 'markdown', markdown, container, baseName },
      sourceFormat: 'md',
      sourceSha256: hash.digest('hex'),
      baseName,
      container,
      markdown,
    };
  }

  private async resolveAsset(asset: BundleAssetRef, signal?: AbortSignal): Promise<Buffer> {
    if (asset.source.kind === 'artifact') return this.artifacts.read(asset.source.uri, signal);
    const physical = await this.authority.authorizeRootRead(asset.source.rootId, asset.source.path);
    return this.authority.readFile(physical, signal);
  }
}

interface AssetManifestEntry {
  path: string;
  mimeType: string | null;
  altText: string | null;
  credit: string | null;
  license: string | null;
}

async function readAssetManifest(
  container: ContentContainer,
  signal?: AbortSignal,
): Promise<Map<string, AssetManifestEntry>> {
  const bytes = await container.readFile(ASSET_MANIFEST_PATH);
  if (!bytes) return new Map();
  throwIfAborted(signal);
  if (bytes.byteLength > MAX_ASSET_MANIFEST_BYTES) {
    throw new Error('The document asset manifest exceeds the byte limit');
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isExactRecord(parsed, ['version', 'assets']) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.assets) ||
      parsed.assets.length > MCP_ARCHIVE_LIMITS.maxEntries
    ) {
      throw new Error('The document asset manifest has an invalid root shape');
    }
    const entries = new Map<string, AssetManifestEntry>();
    for (const candidate of parsed.assets) {
      throwIfAborted(signal);
      if (!isExactRecord(candidate, ['path', 'mimeType', 'altText', 'credit', 'license'])) {
        throw new Error('The document asset manifest contains an invalid entry');
      }
      const path = tryParseWorkspacePath(candidate.path);
      if (
        path === null ||
        path === '' ||
        path === 'index.md' ||
        path.startsWith('.docblocks/') ||
        !isNullableMimeType(candidate.mimeType) ||
        !isNullableMetadata(candidate.altText) ||
        !isNullableMetadata(candidate.credit) ||
        !isNullableMetadata(candidate.license) ||
        entries.has(path)
      ) {
        throw new Error('The document asset manifest contains invalid metadata');
      }
      entries.set(path, {
        path,
        mimeType: candidate.mimeType,
        altText: candidate.altText,
        credit: candidate.credit,
        license: candidate.license,
      });
    }
    return entries;
  } catch (caught: unknown) {
    if (caught instanceof Error && caught.message.startsWith('The document asset manifest')) {
      throw caught;
    }
    const error = new Error('The document asset manifest is not valid JSON');
    Object.defineProperty(error, 'cause', { value: caught, enumerable: false });
    throw error;
  }
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isNullableMetadata(
  value: unknown,
  maximumCharacters = MAX_METADATA_CHARACTERS,
): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && value.length <= maximumCharacters && isWireText(value))
  );
}

function isNullableMimeType(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length <= 256 &&
      /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(value))
  );
}

export function warningDiagnostic(
  message: string,
  stage: McpDiagnostic['stage'],
  format: string | null = null,
): McpDiagnostic {
  const classified = classifyWarning(message, format);
  const normalizedFormat = format?.toLowerCase() ?? null;
  return {
    code: classified.code,
    severity: 'warning',
    stage,
    format:
      normalizedFormat !== null && /^[a-z0-9][a-z0-9.+_-]{0,63}$/u.test(normalizedFormat)
        ? normalizedFormat
        : null,
    count: classified.count,
    message: boundWireText(message, MCP_WIRE_LIMITS.messageCharacters, 'Conversion warning'),
    remediation:
      classified.remediation === null
        ? null
        : boundWireText(classified.remediation, MCP_WIRE_LIMITS.messageCharacters),
    retryable: false,
    location: null,
  };
}

function classifyWarning(
  message: string,
  format: string | null,
): { code: string; count: number; remediation: string | null } {
  const normalized = message.toLowerCase();
  if (normalized.includes('unsupported markdown node')) {
    return {
      code: 'unsupported-markdown-node',
      count: warningCount(message, /omitted\s+(\d+)\s+unsupported/iu),
      remediation:
        'Replace unsupported directives with standard Markdown or choose a target that retains them.',
    };
  }
  if (normalized.includes('csv export emitted only the first')) {
    const tables = warningCount(message, /document has\s+(\d+)\s+tables/iu);
    return {
      code: 'csv-table-selection',
      count: Math.max(1, tables - 1),
      remediation: 'Set tableIndex explicitly or export the full workbook as XLSX.',
    };
  }
  if (normalized.includes('xlsx export is tables-only')) {
    return {
      code: 'xlsx-content-omitted',
      count: warningCount(message, /(\d+)\s+non-table block/iu),
      remediation: 'Move required prose into tables or choose DOCX/PDF/HTML for mixed content.',
    };
  }
  if (normalized.includes('pdf embedded images were skipped')) {
    return {
      code: 'pdf-image-omitted',
      count: 1,
      remediation:
        'Import the PDF in an environment with canvas image decoding or provide the original image assets.',
    };
  }
  if (
    normalized.includes('gif does not support audio') ||
    normalized.includes('gif cannot retain audio')
  ) {
    return {
      code: 'gif-audio-omitted',
      count: 1,
      remediation: 'Use MP4 when audio must be retained, or accept a silent GIF.',
    };
  }
  if (normalized.includes('full-slide image') || normalized.includes('raster image')) {
    return {
      code: 'rendered-content-rasterized',
      count: 1,
      remediation:
        format === 'pptx'
          ? 'Choose editable-native PPTX when native shape editing matters more than exact pixels.'
          : 'Choose semantic PDF when selectable structure matters more than exact pixels.',
    };
  }
  if (normalized.includes('not a fully tagged accessible pdf')) {
    return {
      code: 'pdf-accessibility-limited',
      count: 1,
      remediation: 'Use an accessibility-aware tagged-PDF post-processing workflow.',
    };
  }
  if (normalized.startsWith('theme:')) {
    return {
      code: 'theme-inference-adjusted',
      count: 1,
      remediation: 'Review the inferred theme and adjust its colors before reusing it broadly.',
    };
  }
  if (normalized.includes('layout inference is only available')) {
    return {
      code: 'layout-inference-unsupported',
      count: 1,
      remediation: 'Use a PPTX source when reusable slide-layout inference is required.',
    };
  }
  if (
    (normalized.startsWith('layout ') && normalized.includes('could not be read')) ||
    normalized.includes('missing or unresolved layout')
  ) {
    return {
      code: 'layout-inference-incomplete',
      count: warningCount(message, /(\d+)\s+slide/iu),
      remediation:
        'Review the affected slides and supply explicit templates where inference was incomplete.',
    };
  }
  return { code: 'fidelity-warning', count: 1, remediation: null };
}

function warningCount(message: string, pattern: RegExp): number {
  const value = Number(pattern.exec(message)?.[1] ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('MCP operation was cancelled');
  error.name = 'AbortError';
  throw error;
}

function baseNameFromName(name: string): string {
  const leaf = basename(name.replace(/\\/gu, '/')) || 'document';
  const extension = extname(leaf);
  return (extension ? leaf.slice(0, -extension.length) : leaf) || 'document';
}

function formatFromName(name: string): string {
  const extension = extname(name).replace(/^\./u, '').toLowerCase();
  return extension || 'auto';
}

function normalizeFormat(format: string): string {
  const normalized = format.toLowerCase().replace(/^\./u, '');
  return normalized === 'markdown' ? 'md' : normalized || 'auto';
}
