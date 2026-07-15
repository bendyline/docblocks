import { createHash } from 'node:crypto';
import type {
  AppliedOption,
  ConversionFidelity,
  ConversionResult,
  EngineVersion,
  McpDiagnostic,
} from '@bendyline/docblocks/mcp';
import { DOCBLOCKS_MCP_WIRE_VERSION } from '@bendyline/docblocks/mcp';
import {
  CapturedFrameBudgetError,
  MAX_CAPTURED_FRAME_BYTES,
  createCliRegistry,
  prepareConversion as prepareLinkedConversion,
  type CliConvertOptions,
  type PreparedConversion,
} from '@bendyline/squisq-cli/api';
import { getDocPlaybackDuration } from '@bendyline/squisq/schemas';
import { getDependencyRuntimeVersion, getPackageVersion } from '../version.js';
import { ArtifactStore } from './artifact-store.js';
import type { PreparedDocument } from './document-service.js';
import { MCP_ARCHIVE_LIMITS, throwIfAborted, warningDiagnostic } from './document-service.js';
import { boundDiagnostics } from './intelligence.js';
import { convertRenderedDocument } from './rendered-conversion.js';

export interface ConversionTargetRequest {
  format: string;
  fidelity?: ConversionFidelity;
  options?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ConversionRequestOptions {
  themeId?: string;
  transformId?: string;
  autoTemplates?: boolean;
  title?: string;
  targets: readonly ConversionTargetRequest[];
}

/** Fidelity contracts that the current conversion implementations can actually honor. */
export const MCP_FORMAT_FIDELITIES = {
  md: ['semantic'],
  docx: ['semantic', 'editable-native'],
  pdf: ['semantic', 'rendered-fidelity', 'hybrid'],
  pptx: ['semantic', 'editable-native', 'rendered-fidelity', 'hybrid'],
  xlsx: ['semantic', 'editable-native'],
  csv: ['semantic'],
  html: ['semantic'],
  htmlzip: ['semantic'],
  epub: ['semantic'],
  dbk: ['semantic', 'editable-native'],
  mp4: ['rendered-fidelity'],
  gif: ['rendered-fidelity'],
} as const satisfies Record<string, readonly ConversionFidelity[]>;

export const MCP_MEDIA_RENDER_LIMITS = Object.freeze({
  mp4: Object.freeze({
    maximumFps: 60,
    maximumDimension: 3_840,
    maximumPixelsPerFrame: 8_294_400,
    maximumDurationSeconds: 300,
    maximumFrames: 18_000,
    maximumPixelFrames: 2_200_000_000,
    maximumCapturedFrameBytes: MAX_CAPTURED_FRAME_BYTES,
  }),
  gif: Object.freeze({
    maximumFps: 30,
    maximumDimension: 1_920,
    maximumPixelsPerFrame: 2_073_600,
    maximumDurationSeconds: 120,
    maximumFrames: 3_600,
    maximumPixelFrames: 600_000_000,
    maximumCapturedFrameBytes: MAX_CAPTURED_FRAME_BYTES,
  }),
});

const COMPLETED_CONVERSION_CACHE_LIMIT = 64;
const completedConversionCaches = new WeakMap<ArtifactStore, CompletedConversionCache>();
const linkedRegistry = createCliRegistry();

export type ConversionProgress = (
  completed: number,
  total: number,
  message: string,
) => Promise<void> | void;

/** Injectable conversion boundaries used to test native staging without global module mocks. */
export interface ConversionServiceDependencies {
  readonly prepareNativeConversion: typeof prepareLinkedConversion;
  readonly convertRenderedDocument: typeof convertRenderedDocument;
}

const DEFAULT_CONVERSION_SERVICE_DEPENDENCIES: ConversionServiceDependencies = Object.freeze({
  prepareNativeConversion: prepareLinkedConversion,
  convertRenderedDocument,
});

/** Linked registry metadata plus DocBlocks-only exposure policy. */
export const MCP_FORMAT_CAPABILITIES = Object.freeze(
  linkedRegistry.list().map((definition) =>
    Object.freeze({
      id: definition.id,
      label: definition.label,
      mimeType: definition.mimeType,
      extensions: Object.freeze([...definition.extensions]),
      import:
        definition.importContainer || definition.importDoc
          ? Object.freeze({ supported: true as const, tool: 'inspect_document' })
          : Object.freeze({
              supported: false as const,
              excludedReason: 'The linked registry is export-only.',
            }),
      export: definition.exportDoc
        ? Object.freeze({ supported: true as const, tool: 'convert_document' })
        : Object.freeze({
            supported: false as const,
            excludedReason: 'The linked registry is import-only.',
          }),
    }),
  ),
);

/** Convert one normalized document to multiple immutable artifacts. */
export async function convertPreparedDocument(
  artifacts: ArtifactStore,
  prepared: PreparedDocument,
  request: ConversionRequestOptions,
  signal?: AbortSignal,
  progress?: ConversionProgress,
  dependencies: ConversionServiceDependencies = DEFAULT_CONVERSION_SERVICE_DEPENDENCIES,
): Promise<ConversionResult[]> {
  if (request.targets.length < 1 || request.targets.length > 12) {
    throw new Error('Conversion requires between 1 and 12 targets');
  }
  const duplicate = firstDuplicate(request.targets.map((target) => target.format));
  if (duplicate) throw new Error(`Duplicate conversion target: ${duplicate}`);
  await validateRequestVocabulary(prepared, request);
  const results: ConversionResult[] = [];
  const createdArtifactUris: string[] = [];
  const createdCacheKeys: string[] = [];
  const engineVersions = await conversionEngineVersions();
  let nativePrepared: PreparedConversion | undefined;
  const nativePrepareOptions: CliConvertOptions = {
    registry: linkedRegistry,
    themeId: request.themeId,
    transformStyle: request.transformId,
    autoTemplates: request.autoTemplates,
    title: request.title,
    signal,
  };
  let lastReportedProgress = 0;
  const reportProgress = (completed: number, message: string): Promise<void> | void => {
    const monotonic = Math.max(
      lastReportedProgress,
      Math.min(request.targets.length, Math.max(0, completed)),
    );
    lastReportedProgress = monotonic;
    return progress?.(monotonic, request.targets.length, message);
  };
  try {
    for (let index = 0; index < request.targets.length; index += 1) {
      throwIfAborted(signal);
      const target = request.targets[index]!;
      const definition = linkedRegistry.get(target.format);
      if (!definition) throw new Error(`Unknown conversion target "${target.format}"`);
      if (!definition.exportDoc) throw new Error(`Format "${target.format}" is not export-capable`);
      const fidelity = target.fidelity ?? defaultFidelity(target.format);
      assertSupportedFidelity(target.format, fidelity);
      assertMediaRenderBudget(prepared, target);
      const cacheKey = createConversionCacheKey(
        prepared,
        request,
        target,
        fidelity,
        engineVersions,
      );
      throwIfAborted(signal);
      const cached = await findCompletedConversion(artifacts, cacheKey);
      throwIfAborted(signal);
      if (cached) {
        await reportProgress(index, `Reusing cached ${target.format} artifact`);
        throwIfAborted(signal);
        results.push(cached);
        await reportProgress(index + 1, `Reused cached ${target.format} artifact`);
        throwIfAborted(signal);
        continue;
      }

      await reportProgress(index, `Converting to ${target.format}`);
      const formatOptions: Record<string, unknown> = {
        ...(target.options ?? {}),
        ...(target.format === 'dbk'
          ? { ...MCP_ARCHIVE_LIMITS, compression: 'STORE' as const }
          : {}),
        ...(request.themeId ? { themeId: request.themeId } : {}),
        onProgress: (phase: string, percent: number) => {
          throwIfAborted(signal);
          void reportProgress(
            index + Math.max(0, Math.min(100, percent)) / 100,
            `${target.format}: ${phase}`,
          );
        },
      };
      const converted = usesDocumentRasterizer(target.format, fidelity)
        ? await dependencies.convertRenderedDocument(
            prepared,
            target.format,
            fidelity,
            target.options ?? {},
            {
              themeId: request.themeId,
              transformId: request.transformId,
              autoTemplates: request.autoTemplates,
              title: request.title,
            },
            signal,
            (completed, total, message) =>
              reportProgress(
                index + (total > 0 ? completed / total : 0),
                `${target.format}: ${message}`,
              ),
          )
        : await (async () => {
            nativePrepared ??= await dependencies.prepareNativeConversion(
              {
                kind: 'markdown',
                markdown: prepared.markdownDoc,
                container: prepared.container,
                baseName: prepared.baseName,
              },
              nativePrepareOptions,
            );
            try {
              return await nativePrepared.convert(target.format, {
                signal,
                title: request.title,
                formatOptions: { [target.format]: formatOptions },
              });
            } catch (error: unknown) {
              const capturedFrameBudget = findCapturedFrameBudgetError(error);
              if (capturedFrameBudget && (target.format === 'mp4' || target.format === 'gif')) {
                throw new MediaRenderBudgetError(
                  target.format,
                  [
                    `${capturedFrameBudget.capturedBytes + capturedFrameBudget.attemptedFrameBytes} ` +
                      `captured PNG bytes`,
                  ],
                  MCP_MEDIA_RENDER_LIMITS[target.format],
                );
              }
              throw error;
            }
          })();
      throwIfAborted(signal);
      if (target.format === 'dbk') {
        const { zipToContainer } = await import('@bendyline/squisq-formats/container');
        await zipToContainer(converted.bytes, MCP_ARCHIVE_LIMITS);
        throwIfAborted(signal);
      }
      const appliedOptions = collectAppliedOptions(request, target);
      const artifact = await artifacts.put(
        {
          bytes: converted.bytes,
          format: target.format,
          mimeType: converted.mimeType,
          sourceFormat: prepared.sourceFormat,
          sourceSha256: prepared.sourceSha256,
          suggestedFilename: converted.suggestedFilename,
          appliedOptions,
          engineVersions,
        },
        signal,
      );
      createdArtifactUris.push(artifact.uri);
      const diagnostics: McpDiagnostic[] = boundDiagnostics(
        [
          ...prepared.diagnostics,
          ...converted.warnings.map((warning) =>
            warningDiagnostic(warning, 'convert', target.format),
          ),
        ],
        'convert',
      );
      const result = freezeConversionResult({
        version: DOCBLOCKS_MCP_WIRE_VERSION,
        kind: 'conversion',
        sourceFormat: prepared.sourceFormat,
        targetFormat: target.format,
        artifact,
        fidelity,
        appliedThemeId: request.themeId ?? prepared.doc.themeId ?? null,
        appliedTransformId: request.transformId ?? null,
        sourceAssets: prepared.assets,
        sourceAssetCount: prepared.assets.length,
        diagnostics,
      });
      try {
        await artifacts.attachConversionReport(result);
        throwIfAborted(signal);
      } catch (caught: unknown) {
        await artifacts.discard(artifact.uri);
        throw caught;
      }
      completedConversionCache(artifacts).set(cacheKey, result);
      createdCacheKeys.push(cacheKey);
      results.push(result);
      await reportProgress(index + 1, `Created ${target.format} artifact`);
    }
    throwIfAborted(signal);
    return results;
  } catch (caught: unknown) {
    const cache = completedConversionCache(artifacts);
    for (const key of createdCacheKeys) cache.delete(key);
    await Promise.allSettled(createdArtifactUris.map((uri) => artifacts.discard(uri)));
    throw caught;
  }
}

/** Build the content-addressed cache key for one completed target conversion. */
export function createConversionCacheKey(
  prepared: Pick<
    PreparedDocument,
    'sourceSha256' | 'sourceFormat' | 'baseName' | 'assets' | 'diagnostics'
  >,
  request: Omit<ConversionRequestOptions, 'targets'>,
  target: ConversionTargetRequest,
  fidelity: ConversionFidelity,
  engineVersions: readonly EngineVersion[],
): string {
  const canonical = canonicalJson({
    source: {
      sha256: prepared.sourceSha256,
      format: prepared.sourceFormat,
      baseName: prepared.baseName,
      assets: prepared.assets,
      diagnostics: prepared.diagnostics,
    },
    engines: engineVersions,
    target: {
      format: target.format,
      fidelity,
      options: target.options ?? {},
    },
    request: {
      themeId: request.themeId ?? null,
      transformId: request.transformId ?? null,
      autoTemplates: request.autoTemplates ?? null,
      title: request.title ?? null,
    },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function findCompletedConversion(
  artifacts: ArtifactStore,
  key: string,
): Promise<ConversionResult | null> {
  const cache = completedConversionCache(artifacts);
  const cached = cache.get(key);
  if (!cached) return null;
  try {
    const current = await artifacts.get(cached.artifact.uri);
    if (canonicalJson(current) !== canonicalJson(cached.artifact)) {
      cache.delete(key);
      return null;
    }
    return cached;
  } catch (caught: unknown) {
    if (caught instanceof Error && caught.message === 'Unknown or expired MCP artifact') {
      cache.delete(key);
      return null;
    }
    throw caught;
  }
}

function completedConversionCache(artifacts: ArtifactStore): CompletedConversionCache {
  let cache = completedConversionCaches.get(artifacts);
  if (!cache) {
    cache = new CompletedConversionCache(COMPLETED_CONVERSION_CACHE_LIMIT);
    completedConversionCaches.set(artifacts, cache);
  }
  return cache;
}

class CompletedConversionCache {
  private readonly entries = new Map<string, ConversionResult>();

  public constructor(private readonly maximumEntries: number) {}

  public get(key: string): ConversionResult | null {
    const result = this.entries.get(key);
    if (!result) return null;
    this.entries.delete(key);
    this.entries.set(key, result);
    return result;
  }

  public set(key: string, result: ConversionResult): void {
    this.entries.delete(key);
    this.entries.set(key, result);
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }

  public delete(key: string): void {
    this.entries.delete(key);
  }
}

async function conversionEngineVersions(): Promise<EngineVersion[]> {
  const [cli, formats, squisq] = await Promise.all([
    getDependencyRuntimeVersion('@bendyline/squisq-cli', '@bendyline/squisq-cli/api'),
    getDependencyRuntimeVersion('@bendyline/squisq-formats'),
    getDependencyRuntimeVersion('@bendyline/squisq'),
  ]);
  return [
    { name: 'docblocks', version: getPackageVersion() },
    { name: '@bendyline/squisq-cli', version: cli },
    { name: '@bendyline/squisq-formats', version: formats },
    { name: '@bendyline/squisq', version: squisq },
  ];
}

function freezeConversionResult(result: ConversionResult): ConversionResult {
  return deepFreeze(result);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function defaultFidelity(format: string): ConversionFidelity {
  if (format === 'mp4' || format === 'gif') return 'rendered-fidelity';
  return format === 'docx' || format === 'pptx' ? 'editable-native' : 'semantic';
}

function usesDocumentRasterizer(format: string, fidelity: ConversionFidelity): boolean {
  return (
    (format === 'pdf' || format === 'pptx') &&
    (fidelity === 'rendered-fidelity' || fidelity === 'hybrid')
  );
}

/** Reject media renders before browser/frame capture can consume unbounded memory. */
export function assertMediaRenderBudget(
  prepared: Pick<PreparedDocument, 'doc'>,
  target: ConversionTargetRequest,
): void {
  if (target.format !== 'mp4' && target.format !== 'gif') return;
  const format = target.format;
  const limits = MCP_MEDIA_RENDER_LIMITS[format];
  const options = target.options ?? {};
  const orientation = options.orientation === 'portrait' ? 'portrait' : 'landscape';
  const defaultWidth =
    format === 'mp4'
      ? orientation === 'portrait'
        ? 1_080
        : 1_920
      : orientation === 'portrait'
        ? 540
        : 960;
  const defaultHeight =
    format === 'mp4'
      ? orientation === 'portrait'
        ? 1_920
        : 1_080
      : orientation === 'portrait'
        ? 960
        : 540;
  const width = numericOption(options.width, defaultWidth);
  const height = numericOption(options.height, defaultHeight);
  const fps = numericOption(options.fps, format === 'mp4' ? 30 : 10);
  const coverPreRoll = numericOption(options.coverPreRoll, 0);
  const duration = getDocPlaybackDuration(prepared.doc) + coverPreRoll;
  const frames = Math.ceil(duration * fps);
  const pixelsPerFrame = width * height;
  const pixelFrames = pixelsPerFrame * frames;
  const violations: string[] = [];
  if (width > limits.maximumDimension || height > limits.maximumDimension) {
    violations.push(`dimensions ${width}x${height}`);
  }
  if (fps > limits.maximumFps) violations.push(`${fps} fps`);
  if (pixelsPerFrame > limits.maximumPixelsPerFrame) {
    violations.push(`${pixelsPerFrame} pixels per frame`);
  }
  if (!Number.isFinite(duration) || duration > limits.maximumDurationSeconds) {
    violations.push(`${duration} seconds`);
  }
  if (!Number.isSafeInteger(frames) || frames > limits.maximumFrames) {
    violations.push(`${frames} frames`);
  }
  if (!Number.isSafeInteger(pixelFrames) || pixelFrames > limits.maximumPixelFrames) {
    violations.push(`${pixelFrames} frame-pixels`);
  }
  if (violations.length > 0) throw new MediaRenderBudgetError(format, violations, limits);
}

function numericOption(
  value: string | number | boolean | null | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function findCapturedFrameBudgetError(error: unknown): CapturedFrameBudgetError | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof CapturedFrameBudgetError) return current;
    if (typeof current !== 'object' || current === null || seen.has(current)) return undefined;
    seen.add(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export class MediaRenderBudgetError extends Error {
  public readonly code = 'media-budget-exceeded';
  public readonly retryable = false;
  public readonly hint: string;

  public constructor(
    public readonly format: 'mp4' | 'gif',
    violations: readonly string[],
    limits: (typeof MCP_MEDIA_RENDER_LIMITS)['mp4' | 'gif'],
  ) {
    super(
      `The ${format.toUpperCase()} render exceeds MCP media budgets: ${violations.join(', ')}.`,
    );
    this.name = 'MediaRenderBudgetError';
    this.hint =
      `Reduce duration, FPS, or dimensions. ${format.toUpperCase()} permits at most ` +
      `${limits.maximumDurationSeconds}s, ${limits.maximumFps} fps, ` +
      `${limits.maximumPixelsPerFrame} pixels/frame, ${limits.maximumPixelFrames} frame-pixels, ` +
      `and ${limits.maximumCapturedFrameBytes} retained captured-PNG bytes.`;
  }
}

export function supportedFidelities(format: string): readonly ConversionFidelity[] {
  return MCP_FORMAT_FIDELITIES[format as keyof typeof MCP_FORMAT_FIDELITIES] ?? ([] as const);
}

export function assertSupportedFidelity(format: string, fidelity: ConversionFidelity): void {
  const supported = supportedFidelities(format);
  if (supported.includes(fidelity)) return;
  throw new UnsupportedFidelityError(format, fidelity, supported);
}

export class UnsupportedFidelityError extends Error {
  public readonly code = 'unsupported-fidelity';
  public readonly format: string;
  public readonly hint: string;

  public constructor(
    format: string,
    fidelity: ConversionFidelity,
    supported: readonly ConversionFidelity[],
  ) {
    const choices = supported.length > 0 ? supported.join(', ') : 'none';
    super(`Fidelity "${fidelity}" is not supported for target "${format}".`);
    this.name = 'UnsupportedFidelityError';
    this.format = format;
    this.hint = `Supported fidelities for ${format}: ${choices}.`;
  }
}

export class UnknownTransformError extends Error {
  public readonly code = 'unknown-transform';
  public readonly hint = 'Choose a transform id reported by list_transform_styles.';

  public constructor(transformId: string) {
    super(`Unknown transform style "${transformId}".`);
    this.name = 'UnknownTransformError';
  }
}

export class UnknownThemeError extends Error {
  public readonly code = 'unknown-theme';
  public readonly hint =
    'Choose a built-in id from list_themes or a custom theme embedded in the document.';

  public constructor(themeId: string) {
    super(`Unknown theme "${themeId}".`);
    this.name = 'UnknownThemeError';
  }
}

async function validateRequestVocabulary(
  prepared: PreparedDocument,
  request: ConversionRequestOptions,
): Promise<void> {
  const checks: Promise<void>[] = [];
  const transformId = request.transformId;
  if (transformId) {
    checks.push(
      import('@bendyline/squisq/transform').then(({ getTransformStyleIds }) => {
        if (!getTransformStyleIds().includes(transformId)) {
          throw new UnknownTransformError(transformId);
        }
      }),
    );
  }
  const themeId = request.themeId;
  if (themeId) {
    checks.push(
      import('@bendyline/squisq/schemas').then(({ getAvailableThemes }) => {
        const custom = prepared.doc.customThemes?.some((theme) => theme.id === themeId);
        if (!custom && !getAvailableThemes().includes(themeId)) {
          throw new UnknownThemeError(themeId);
        }
      }),
    );
  }
  await Promise.all(checks);
}

function collectAppliedOptions(
  request: ConversionRequestOptions,
  target: ConversionTargetRequest,
): AppliedOption[] {
  const values: Record<string, string | number | boolean | null | undefined> = {
    themeId: request.themeId,
    transformId: request.transformId,
    autoTemplates: request.autoTemplates,
    title: request.title,
    fidelity: target.fidelity ?? defaultFidelity(target.format),
    ...(target.options ?? {}),
  };
  return Object.entries(values)
    .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}
