import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { collectImagePaths, docToHtml } from '@bendyline/squisq-formats/html';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';
import { readContainedFile } from './contained-file.js';

export interface RenderMarkdownHtmlOptions {
  title: string;
  sourcePath?: string;
  assetRoot?: string;
  themeId?: string;
  mode?: 'slideshow' | 'static';
  maxAssetBytes?: number;
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
): Promise<Map<string, ArrayBuffer>> {
  const images = new Map<string, ArrayBuffer>();
  const root = await realpath(path.resolve(assetRoot)).catch(() => null);
  const baseDir = await realpath(path.dirname(path.resolve(sourcePath))).catch(() => null);
  if (!root || !baseDir || !isPathInside(root, baseDir)) return images;
  let totalBytes = 0;

  for (const imagePath of [...collectImagePaths(doc)].slice(0, MAX_REFERENCED_IMAGES)) {
    if (!isLocalRelativePath(imagePath)) continue;

    const normalizedPath = stripUrlSuffix(imagePath);
    const absolutePath = path.resolve(baseDir, normalizedPath);
    if (!isPathInside(root, absolutePath)) continue;

    try {
      const physicalPath = await realpath(absolutePath);
      if (!isPathInside(root, physicalPath)) continue;
      const info = await stat(physicalPath);
      if (
        !info.isFile() ||
        info.size > MAX_SINGLE_ASSET_BYTES ||
        totalBytes + info.size > maxAssetBytes
      ) {
        continue;
      }
      const data = await readContainedFile(root, physicalPath, MAX_SINGLE_ASSET_BYTES);
      totalBytes += data.byteLength;
      images.set(imagePath, toExactArrayBuffer(data));
    } catch {
      // Missing assets should not prevent the document from rendering.
    }
  }

  return images;
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

function isPathInside(rootAbs: string, candidateAbs: string): boolean {
  const rel = path.relative(path.resolve(rootAbs), path.resolve(candidateAbs));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function toExactArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}
