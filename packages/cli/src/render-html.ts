import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { collectImagePaths, docToHtml } from '@bendyline/squisq-formats/html';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';
import { readContainedFile } from './contained-file.js';
import { isPathInside } from './internal/paths.js';
import { isNodeErrorCode } from './internal/node-error.js';

export interface ReferencedAssetPath {
  assetRoot: string;
  requestedPath: string;
  physicalPath: string;
}

export interface RenderMarkdownHtmlOptions {
  title: string;
  sourcePath?: string;
  assetRoot?: string;
  themeId?: string;
  mode?: 'slideshow' | 'static';
  maxAssetBytes?: number;
  /** Optional surface policy applied after mandatory physical containment. */
  allowReferencedAsset?: (asset: ReferencedAssetPath) => boolean;
  /** Test/programmatic seam; the CLI reports dropped assets on stderr. */
  onWarning?: (message: string) => void;
}

const MAX_REFERENCED_IMAGES = 100;
const DEFAULT_MAX_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_SINGLE_ASSET_BYTES = 20 * 1024 * 1024;

export async function renderMarkdownHtml(
  markdown: string,
  options: RenderMarkdownHtmlOptions,
): Promise<string> {
  const markdownDoc = parseMarkdown(markdown);
  const doc = markdownToDoc(markdownDoc);
  const images =
    options.sourcePath && options.assetRoot
      ? await readReferencedImages(
          doc,
          options.sourcePath,
          options.assetRoot,
          options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
          options.allowReferencedAsset,
          options.onWarning ?? ((message) => console.warn(message)),
        )
      : undefined;

  return docToHtml(doc, {
    playerScript: PLAYER_BUNDLE,
    images,
    title: options.title,
    mode: options.mode ?? 'static',
    themeId: options.themeId,
  });
}

async function readReferencedImages(
  doc: ReturnType<typeof markdownToDoc>,
  sourcePath: string,
  assetRoot: string,
  maxAssetBytes: number,
  allowReferencedAsset: RenderMarkdownHtmlOptions['allowReferencedAsset'],
  warn: (message: string) => void,
): Promise<Map<string, ArrayBuffer>> {
  const images = new Map<string, ArrayBuffer>();
  const root = await realpathIfPresent(path.resolve(assetRoot));
  const baseDir = await realpathIfPresent(path.dirname(path.resolve(sourcePath)));
  if (!root || !baseDir || !isPathInside(root, baseDir)) return images;
  let totalBytes = 0;

  // The budget stands; only its silence was the defect. Dropping images past
  // the cap produced valid-looking HTML with invisibly broken images.
  const referenced = [...collectImagePaths(doc)];
  const embeddable = referenced.slice(0, MAX_REFERENCED_IMAGES);
  const dropped = referenced.slice(MAX_REFERENCED_IMAGES);
  if (dropped.length > 0) {
    warn(
      `Skipped ${dropped.length} of ${referenced.length} referenced images: the render embeds at most ${MAX_REFERENCED_IMAGES}. Not embedded: ${describeList(dropped)}`,
    );
  }

  for (const imagePath of embeddable) {
    if (!isLocalRelativePath(imagePath)) continue;

    const normalizedPath = stripUrlSuffix(imagePath);
    const absolutePath = path.resolve(baseDir, normalizedPath);
    if (!isPathInside(root, absolutePath)) continue;

    try {
      const physicalPath = await realpath(absolutePath);
      if (!isPathInside(root, physicalPath)) continue;
      if (
        allowReferencedAsset &&
        !allowReferencedAsset({
          assetRoot: root,
          requestedPath: absolutePath,
          physicalPath,
        })
      ) {
        continue;
      }
      const info = await stat(physicalPath);
      if (!info.isFile()) {
        warn(`Skipped referenced image "${imagePath}": it is not a regular file.`);
        continue;
      }
      if (info.size > MAX_SINGLE_ASSET_BYTES) {
        warn(
          `Skipped referenced image "${imagePath}": ${info.size} bytes exceeds the ${MAX_SINGLE_ASSET_BYTES}-byte per-image embed limit.`,
        );
        continue;
      }
      if (totalBytes + info.size > maxAssetBytes) {
        warn(
          `Skipped referenced image "${imagePath}": embedding ${info.size} more bytes would exceed the ${maxAssetBytes}-byte total image budget (${totalBytes} bytes already embedded).`,
        );
        continue;
      }
      const data = await readContainedFile(root, physicalPath, MAX_SINGLE_ASSET_BYTES);
      totalBytes += data.byteLength;
      images.set(imagePath, toExactArrayBuffer(data));
    } catch (error: unknown) {
      // A missing referenced asset is rendered as a normal broken image. Other
      // failures must stay visible rather than silently producing incomplete HTML.
      if (isMissingPathError(error)) continue;
      const contextualError = new Error(`Failed to embed referenced image "${imagePath}".`);
      (contextualError as Error & { cause?: unknown }).cause = error;
      throw contextualError;
    }
  }

  return images;
}

async function realpathIfPresent(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch (error: unknown) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return isNodeErrorCode(error, ['ENOENT', 'ENOTDIR']);
}

function describeList(values: readonly string[], shown = 5): string {
  const head = values.slice(0, shown).map((value) => `"${value}"`);
  const remaining = values.length - head.length;
  return remaining > 0 ? `${head.join(', ')} (and ${remaining} more)` : head.join(', ');
}

function isLocalRelativePath(candidate: string): boolean {
  return (
    !path.isAbsolute(candidate) &&
    !candidate.startsWith('/') &&
    !/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(candidate) &&
    !candidate.startsWith('data:')
  );
}

function stripUrlSuffix(candidate: string): string {
  return candidate.split(/[?#]/, 1)[0] ?? candidate;
}

function toExactArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}
