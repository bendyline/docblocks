import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { collectImagePaths, docToHtml } from '@bendyline/squisq-formats/html';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';

export interface RenderMarkdownHtmlOptions {
  title: string;
  sourcePath?: string;
  assetRoot?: string;
  themeId?: string;
  mode?: 'slideshow' | 'static';
}

export async function renderMarkdownHtml(
  markdown: string,
  options: RenderMarkdownHtmlOptions,
): Promise<string> {
  const markdownDoc = parseMarkdown(markdown);
  const doc = markdownToDoc(markdownDoc);
  const images =
    options.sourcePath && options.assetRoot
      ? await readReferencedImages(doc, options.sourcePath, options.assetRoot)
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
): Promise<Map<string, ArrayBuffer>> {
  const images = new Map<string, ArrayBuffer>();
  const baseDir = path.dirname(path.resolve(sourcePath));
  const root = path.resolve(assetRoot);

  for (const imagePath of collectImagePaths(doc)) {
    if (!isLocalRelativePath(imagePath)) continue;

    const normalizedPath = stripUrlSuffix(imagePath);
    const absolutePath = path.resolve(baseDir, normalizedPath);
    if (!isPathInside(root, absolutePath)) continue;

    try {
      const data = await readFile(absolutePath);
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
