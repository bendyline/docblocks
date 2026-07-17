import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type {
  ArtifactRef,
  EngineVersion,
  McpDiagnostic,
  PreviewItem,
  PreviewItemKind,
  PreviewResult,
} from '@bendyline/docblocks/mcp';
import { DOCBLOCKS_MCP_WIRE_VERSION } from '@bendyline/docblocks/mcp';
import type { Doc } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { getDependencyRuntimeVersion, getPackageVersion } from '../version.js';
import { ArtifactStore } from './artifact-store.js';
import type { PreparedDocument } from './document-service.js';
import { throwIfAborted } from './document-service.js';
import { authoringDiagnostics, boundDiagnostics } from './intelligence.js';

const DEFAULT_WIDTH = 1_280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_MAX_ITEMS = 8;
const MAX_ITEMS = 20;
const MAX_RENDERED_ITEMS = 100;
export const MCP_PREVIEW_CAPTURE_LIMITS = Object.freeze({
  maximumAggregatePixels: 120_000_000,
  maximumCapturedBytes: 64 * 1024 * 1024,
});

export interface PreviewRequestOptions {
  startIndex?: number;
  maxItems?: number;
  width?: number;
  height?: number;
}

/**
 * Fingerprinting the linked runtime is I/O-bound, so it is awaited rather than
 * computed inline: a preview is served by the same stdio server that must stay
 * responsive to progress and cancellation traffic. The result is cached in
 * `version.ts`, so only the first call per process pays for the walk.
 */
async function previewEngineVersions(): Promise<EngineVersion[]> {
  return [
    { name: 'docblocks', version: getPackageVersion() },
    {
      name: '@bendyline/squisq-cli',
      version: await getDependencyRuntimeVersion(
        '@bendyline/squisq-cli',
        '@bendyline/squisq-cli/api',
      ),
    },
  ];
}

export interface CapturedPreview {
  bytes: Uint8Array;
  index: number;
  label: string | null;
  width: number;
  height: number;
}

export type PreviewProgress = (
  completed: number,
  total: number,
  message: string,
) => Promise<void> | void;

export type PreviewCapture = (
  doc: Doc,
  container: ContentContainer,
  options: Required<Pick<PreviewRequestOptions, 'startIndex' | 'maxItems' | 'width' | 'height'>>,
  signal?: AbortSignal,
  progress?: PreviewProgress,
) => Promise<{
  captures: CapturedPreview[];
  totalItems: number;
  diagnostics?: McpDiagnostic[];
}>;

export interface VideoPreviewSource {
  bytes: Uint8Array;
  filename: string;
  format: string;
  sha256: string;
}

export type VideoThumbnailExtractionOptions =
  import('@bendyline/squisq-cli/api').ExtractThumbnailsOptions;
export type VideoThumbnailExtractor = typeof import('@bendyline/squisq-cli/api').extractThumbnails;

export type PreviewBrowserLauncher = () => Promise<import('playwright-core').Browser>;

/** Capture every visual item for rendered-fidelity conversion without publishing intermediates. */
export async function capturePreparedDocumentFrames(
  prepared: PreparedDocument,
  options: { width?: number; height?: number } = {},
  signal?: AbortSignal,
  progress?: PreviewProgress,
): Promise<CapturedPreview[]> {
  const normalized = normalizeOptions({
    startIndex: 0,
    maxItems: MAX_ITEMS,
    width: options.width ?? 1_200,
    height: options.height ?? 900,
  });
  const { flattenBlocks } = await import('@bendyline/squisq/doc');
  const totalItems = flattenBlocks(prepared.doc.blocks).length;
  if (totalItems > MAX_RENDERED_ITEMS) {
    throw new Error(
      `Rendered-fidelity conversion supports at most ${MAX_RENDERED_ITEMS} visual items`,
    );
  }
  const rendered = await captureWithPlaywright(
    prepared.doc,
    prepared.container,
    { ...normalized, maxItems: Math.max(1, totalItems) },
    signal,
    progress,
  );
  if (rendered.captures.length !== totalItems) {
    throw new Error('Rendered-fidelity capture did not produce every visual item');
  }
  assertCapturedPreviewBudget(rendered.captures);
  return rendered.captures;
}

/** Render bounded Squisq visual previews into immutable PNG artifacts. */
export async function previewPreparedDocument(
  artifacts: ArtifactStore,
  prepared: PreparedDocument,
  request: PreviewRequestOptions,
  signal?: AbortSignal,
  progress?: PreviewProgress,
  capture: PreviewCapture = captureWithPlaywright,
  maximumCapturedBytes = MCP_PREVIEW_CAPTURE_LIMITS.maximumCapturedBytes,
): Promise<PreviewResult> {
  const options = normalizeOptions(request);
  throwIfAborted(signal);
  const rendered = await capture(prepared.doc, prepared.container, options, signal, progress);
  assertCapturedPreviewBudget(rendered.captures, maximumCapturedBytes);
  const previewBasis =
    prepared.sourceFormat === 'md' || prepared.sourceFormat === 'dbk'
      ? 'source-render'
      : 'reconstructed-import';
  const itemKind = previewItemKind(prepared.sourceFormat);
  const items: PreviewItem[] = [];
  const createdArtifactUris: string[] = [];
  const engineVersions = await previewEngineVersions();
  try {
    for (const captured of rendered.captures) {
      throwIfAborted(signal);
      const artifact = await artifacts.put(
        {
          bytes: captured.bytes,
          format: 'png',
          mimeType: 'image/png',
          sourceFormat: prepared.sourceFormat,
          sourceSha256: prepared.sourceSha256,
          suggestedFilename: `${prepared.baseName}-preview-${String(captured.index + 1).padStart(3, '0')}.png`,
          appliedOptions: [
            { name: 'width', value: captured.width },
            { name: 'height', value: captured.height },
            { name: 'itemIndex', value: captured.index },
          ],
          engineVersions,
        },
        signal,
      );
      createdArtifactUris.push(artifact.uri);
      items.push({
        kind: itemKind,
        index: captured.index,
        label: captured.label,
        artifact,
        width: captured.width,
        height: captured.height,
      });
    }
    throwIfAborted(signal);
  } catch (caught: unknown) {
    await Promise.allSettled(createdArtifactUris.map((uri) => artifacts.discard(uri)));
    throw caught;
  }
  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'preview',
    sourceFormat: prepared.sourceFormat,
    previewBasis,
    totalItems: rendered.totalItems,
    items,
    truncated: options.startIndex > 0 || options.startIndex + items.length < rendered.totalItems,
    diagnostics: boundDiagnostics(
      [
        ...prepared.diagnostics,
        ...(await authoringDiagnostics(prepared, 'render', prepared.sourceFormat, signal)),
        ...(rendered.diagnostics ?? []),
        ...(previewBasis === 'reconstructed-import'
          ? [reconstructedPreviewDiagnostic(prepared.sourceFormat)]
          : []),
      ],
      'render',
    ),
  };
}

/** Extract one bounded first-frame JPEG from an existing MP4 or GIF source. */
export async function previewVideoSource(
  artifacts: ArtifactStore,
  source: VideoPreviewSource,
  request: PreviewRequestOptions,
  signal?: AbortSignal,
  progress?: PreviewProgress,
  extract?: VideoThumbnailExtractor,
): Promise<PreviewResult> {
  const options = normalizeOptions(request);
  const sourceFormat = source.format.toLowerCase().replace(/^\./u, '');
  if (sourceFormat !== 'mp4' && sourceFormat !== 'gif') {
    throw new Error('Rendered-media thumbnail preview requires an MP4 or GIF source');
  }
  if (options.startIndex > 0) {
    throw new Error('Preview startIndex is beyond the available items');
  }
  throwIfAborted(signal);

  const directory = await mkdtemp(join(tmpdir(), 'docblocks-mcp-video-preview-'));
  const inputPath = join(directory, `source.${sourceFormat}`);
  const slug = 'first-frame';
  const outputPath = join(directory, `${slug}-${options.width}x${options.height}.jpg`);
  let thumbnail: Buffer;
  try {
    await progress?.(0, 3, 'Staging video preview');
    await writeFile(inputPath, source.bytes, { signal });
    throwIfAborted(signal);
    const extractor = extract ?? (await import('@bendyline/squisq-cli/api')).extractThumbnails;
    await progress?.(1, 3, 'Extracting first video frame');
    await extractor({
      videoPath: inputPath,
      outputDir: directory,
      slug,
      sizes: [
        {
          name: 'preview',
          width: options.width,
          height: options.height,
          filter: thumbnailFilter(options.width, options.height),
        },
      ],
      force: true,
      signal,
    });
    throwIfAborted(signal);
    thumbnail = await readFile(outputPath, { signal });
    throwIfAborted(signal);
    await progress?.(2, 3, 'Publishing video preview');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  throwIfAborted(signal);
  const baseName = baseNameFromFilename(source.filename);
  let artifact: ArtifactRef | null = null;
  try {
    artifact = await artifacts.put(
      {
        bytes: thumbnail,
        format: 'jpg',
        mimeType: 'image/jpeg',
        sourceFormat,
        sourceSha256: source.sha256,
        suggestedFilename: `${baseName}-preview-001.jpg`,
        appliedOptions: [
          { name: 'width', value: options.width },
          { name: 'height', value: options.height },
          { name: 'itemIndex', value: 0 },
        ],
        engineVersions: await previewEngineVersions(),
      },
      signal,
    );
    throwIfAborted(signal);
    await progress?.(3, 3, 'Video preview complete');
    throwIfAborted(signal);
  } catch (caught: unknown) {
    if (artifact) await artifacts.discard(artifact.uri).catch(() => undefined);
    throw caught;
  }
  if (!artifact) throw new Error('Video preview artifact publication failed');
  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'preview',
    sourceFormat,
    previewBasis: 'native-extracted',
    totalItems: 1,
    items: [
      {
        kind: 'frame',
        index: 0,
        label: 'First frame',
        artifact,
        width: options.width,
        height: options.height,
      },
    ],
    truncated: false,
    diagnostics: [],
  };
}

function reconstructedPreviewDiagnostic(format: string): McpDiagnostic {
  return {
    code: 'preview-reconstructed',
    severity: 'warning',
    stage: 'render',
    format,
    count: 1,
    message:
      'Preview images render the normalized imported document and may differ from the native application pixels.',
    remediation:
      'Use the preview for structural review; open the saved artifact in its native application for exact target-pixel verification.',
    retryable: false,
    location: null,
  };
}

function normalizeOptions(
  request: PreviewRequestOptions,
): Required<Pick<PreviewRequestOptions, 'startIndex' | 'maxItems' | 'width' | 'height'>> {
  const options = {
    startIndex: request.startIndex ?? 0,
    maxItems: request.maxItems ?? DEFAULT_MAX_ITEMS,
    width: request.width ?? DEFAULT_WIDTH,
    height: request.height ?? DEFAULT_HEIGHT,
  };
  if (!Number.isSafeInteger(options.startIndex) || options.startIndex < 0) {
    throw new Error('Preview startIndex must be a non-negative integer');
  }
  if (
    !Number.isSafeInteger(options.maxItems) ||
    options.maxItems < 1 ||
    options.maxItems > MAX_ITEMS
  ) {
    throw new Error(`Preview maxItems must be between 1 and ${MAX_ITEMS}`);
  }
  if (!Number.isSafeInteger(options.width) || options.width < 160 || options.width > 1_920) {
    throw new Error('Preview width must be between 160 and 1920 pixels');
  }
  if (!Number.isSafeInteger(options.height) || options.height < 90 || options.height > 1_920) {
    throw new Error('Preview height must be between 90 and 1920 pixels');
  }
  if (options.width * options.height > 2_073_600) {
    throw new Error('Preview pixel area must not exceed 1920x1080');
  }
  return options;
}

function thumbnailFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
}

function baseNameFromFilename(filename: string): string {
  const leaf = basename(filename.replace(/\\/gu, '/')) || 'video';
  const extension = extname(leaf);
  return (extension ? leaf.slice(0, -extension.length) : leaf) || 'video';
}

export async function captureWithPlaywright(
  doc: Doc,
  container: ContentContainer,
  options: Required<Pick<PreviewRequestOptions, 'startIndex' | 'maxItems' | 'width' | 'height'>>,
  signal?: AbortSignal,
  progress?: PreviewProgress,
  launchBrowser?: PreviewBrowserLauncher,
): Promise<{
  captures: CapturedPreview[];
  totalItems: number;
  diagnostics?: McpDiagnostic[];
}> {
  throwIfAborted(signal);
  const { flattenBlocks } = await import('@bendyline/squisq/doc');
  const blocks = flattenBlocks(doc.blocks);
  const selected = blocks.slice(options.startIndex, options.startIndex + options.maxItems);
  if (selected.length === 0 && blocks.length > 0) {
    throw new Error('Preview startIndex is beyond the available items');
  }
  if (blocks.length === 0) return { captures: [], totalItems: 0 };
  const aggregatePixels = options.width * options.height * selected.length;
  if (aggregatePixels > MCP_PREVIEW_CAPTURE_LIMITS.maximumAggregatePixels) {
    throw new Error(
      `Preview capture exceeds the ${MCP_PREVIEW_CAPTURE_LIMITS.maximumAggregatePixels} aggregate-pixel budget`,
    );
  }

  await progress?.(0, selected.length + 2, 'Collecting preview media');
  const { images, audio } = await collectMedia(container, signal);
  const [{ generateRenderHtml }, { PLAYER_BUNDLE }] = await Promise.all([
    import('@bendyline/squisq-video'),
    import('@bendyline/squisq-react/standalone-source'),
  ]);
  const html = generateRenderHtml(doc, {
    playerScript: PLAYER_BUNDLE,
    images,
    audio: audio.size > 0 ? audio : undefined,
    width: options.width,
    height: options.height,
    animationsEnabled: false,
  });
  throwIfAborted(signal);
  await progress?.(1, selected.length + 2, 'Launching preview renderer');
  const browser = launchBrowser
    ? await launchBrowser()
    : await import('playwright-core').then(({ chromium }) => chromium.launch({ headless: true }));
  if (signal?.aborted) {
    await browser.close().catch(() => undefined);
    throwIfAborted(signal);
  }
  const handleAbort = (): void => {
    void browser.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', handleAbort, { once: true });
  let renderApi: import('playwright-core').JSHandle<BrowserRenderApi> | null = null;
  try {
    const page = await browser.newPage({
      viewport: { width: options.width, height: options.height },
    });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(
      () => {
        const root = document.getElementById('squisq-root');
        const player = (window as unknown as SquisqBrowserWindow).SquisqPlayer;
        return root ? player?.getHandle(root)?.getRenderAPI() != null : false;
      },
      { timeout: 15_000 },
    );
    renderApi = await page.evaluateHandle(() => {
      const root = document.getElementById('squisq-root');
      const player = (window as unknown as SquisqBrowserWindow).SquisqPlayer;
      const api = root ? player?.getHandle(root)?.getRenderAPI() : null;
      if (!api) throw new Error('Squisq preview render API did not initialize');
      return api;
    });
    const captures: CapturedPreview[] = [];
    const diagnostics: McpDiagnostic[] = [];
    for (let offset = 0; offset < selected.length; offset += 1) {
      throwIfAborted(signal);
      const block = selected[offset]!;
      const time = block.startTime + Math.min(0.1, Math.max(0, block.duration / 4));
      await renderApi.evaluate((api, value: number) => api.seekTo(value), time);
      const layoutAudit = await page.evaluate(() => {
        const root = document.getElementById('squisq-root');
        if (!root) return { overflowCount: 0, missingFonts: [] as string[] };
        let overflowCount = 0;
        const missingFonts = new Set<string>();
        for (const element of root.querySelectorAll<HTMLElement>('*')) {
          if (element.clientWidth <= 0 || element.clientHeight <= 0) continue;
          const style = getComputedStyle(element);
          const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
          const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
          if (
            (clipsX && element.scrollWidth > element.clientWidth + 2) ||
            (clipsY && element.scrollHeight > element.clientHeight + 2)
          ) {
            overflowCount += 1;
          }
          if (element.textContent?.trim() && document.fonts && style.fontFamily) {
            try {
              if (!document.fonts.check(`12px ${style.fontFamily}`)) {
                missingFonts.add(style.fontFamily.slice(0, 256));
              }
            } catch {
              missingFonts.add(style.fontFamily.slice(0, 256));
            }
          }
        }
        return { overflowCount, missingFonts: [...missingFonts].slice(0, 20) };
      });
      const bytes = await page.screenshot({ type: 'png', animations: 'disabled' });
      const index = options.startIndex + offset;
      captures.push({
        bytes,
        index,
        label: block.title ?? block.id ?? null,
        width: options.width,
        height: options.height,
      });
      assertCapturedPreviewBudget(captures);
      if (layoutAudit.overflowCount > 0) {
        diagnostics.push({
          code: 'rendered-overflow',
          severity: 'warning',
          stage: 'render',
          format: 'png',
          count: layoutAudit.overflowCount,
          message: `Preview item ${index + 1} contains clipped rendered content.`,
          remediation: 'Reduce content density, shorten text, or choose a roomier template.',
          retryable: false,
          location: { kind: 'item', itemKind: 'frame', index },
        });
      }
      if (layoutAudit.missingFonts.length > 0) {
        diagnostics.push({
          code: 'font-unavailable',
          severity: 'warning',
          stage: 'render',
          format: 'png',
          count: layoutAudit.missingFonts.length,
          message: `Preview item ${index + 1} could not confirm these fonts: ${layoutAudit.missingFonts.join(', ')}.`,
          remediation:
            'Embed or install the fonts, or choose a theme with available font families.',
          retryable: false,
          location: { kind: 'item', itemKind: 'frame', index },
        });
      }
      await progress?.(offset + 2, selected.length + 2, `Rendered preview ${index + 1}`);
    }
    await progress?.(selected.length + 2, selected.length + 2, 'Preview complete');
    return { captures, totalItems: blocks.length, diagnostics };
  } finally {
    signal?.removeEventListener('abort', handleAbort);
    await renderApi?.dispose().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export function assertCapturedPreviewBudget(
  captures: readonly Pick<CapturedPreview, 'bytes'>[],
  maximumBytes = MCP_PREVIEW_CAPTURE_LIMITS.maximumCapturedBytes,
): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('Preview capture byte budget must be a positive integer');
  }
  let totalBytes = 0;
  for (const capture of captures) {
    totalBytes += capture.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
      throw new Error(`Preview capture exceeds the ${maximumBytes}-byte aggregate budget`);
    }
  }
}

async function collectMedia(
  container: ContentContainer,
  signal?: AbortSignal,
): Promise<{ images: Map<string, ArrayBuffer>; audio: Map<string, ArrayBuffer> }> {
  const images = new Map<string, ArrayBuffer>();
  const audio = new Map<string, ArrayBuffer>();
  for (const entry of await container.listFiles()) {
    throwIfAborted(signal);
    const bytes = await container.readFile(entry.path);
    if (!bytes) continue;
    if (/\.(?:mp3|m4a|aac|wav|ogg|oga|webm)$/iu.test(entry.path)) {
      audio.set(entry.path, bytes);
    } else if (/\.(?:avif|bmp|gif|jpe?g|png|svg|webp|mp4|mov|m4v)$/iu.test(entry.path)) {
      images.set(entry.path, bytes);
      const leaf = entry.path.split('/').pop();
      if (leaf) images.set(leaf, bytes);
    }
  }
  return { images, audio };
}

function previewItemKind(format: string): PreviewItemKind {
  switch (format.toLowerCase()) {
    case 'pptx':
      return 'slide';
    case 'xlsx':
    case 'csv':
      return 'sheet';
    case 'mp4':
    case 'gif':
      return 'frame';
    default:
      return 'page';
  }
}

interface BrowserRenderApi {
  seekTo(time: number): Promise<void>;
}

interface BrowserPlayerHandle {
  getRenderAPI(): BrowserRenderApi | null;
}

interface BrowserStandalonePlayer {
  getHandle(element: Element): BrowserPlayerHandle | undefined;
}

interface SquisqBrowserWindow {
  SquisqPlayer?: BrowserStandalonePlayer;
}

export function previewFailureDiagnostic(message: string): McpDiagnostic {
  return {
    code: 'preview-failed',
    severity: 'error',
    stage: 'render',
    format: 'png',
    count: 1,
    message,
    remediation: 'Install Playwright Chromium and retry with fewer or smaller preview items.',
    retryable: true,
    location: null,
  };
}
