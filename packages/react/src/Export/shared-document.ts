import {
  SHARED_DOCUMENT_LIMITS,
  createSharedDocumentUrl,
  type SharedDocumentMode,
} from '@bendyline/docblocks/share';

export const PUBLIC_DOCBLOCKS_SHARE_URL = 'https://docblocks.com/';

/** Use the current web deployment, but never emit an unopenable app:// link. */
export function resolveSharedDocumentBaseUrl(currentUrl: string): string {
  try {
    const current = new URL(currentUrl);
    if (current.protocol === 'http:' || current.protocol === 'https:') {
      current.hash = '';
      current.searchParams.delete('action');
      return current.toString();
    }
  } catch {
    // Fall through to the canonical public site.
  }
  return PUBLIC_DOCBLOCKS_SHARE_URL;
}

export function sharedDocumentFilename(selectedFile: string | null): string {
  const basename = selectedFile?.replace(/\\/gu, '/').split('/').pop() ?? 'shared.md';
  const stem = basename.replace(/\.md$/iu, '').replace(/[^A-Za-z0-9._-]+/gu, '-');
  const bounded = stem.replace(/^-+|-+$/gu, '').slice(0, 80) || 'shared';
  return `${bounded}.md`;
}

async function omitSharedImages(markdown: string): Promise<string> {
  const { parseMarkdown, rewriteMarkdownReferences, splitFrontmatterBlock, walkMarkdownTree } =
    await import('@bendyline/squisq/markdown');
  const { frontmatter, body } = splitFrontmatterBlock(markdown);
  const imageReferences = new Set<string>();
  const linkReferences = new Set<string>();
  walkMarkdownTree(parseMarkdown(body, { frontmatter: false }), (node) => {
    if (node.type === 'imageReference') imageReferences.add(node.identifier);
    if (node.type === 'linkReference') linkReferences.add(node.identifier);
  });

  // Keep Markdown/HTML interpretation in Squisq, leaving code examples and
  // unrelated source unchanged.
  let sharedBody = rewriteMarkdownReferences(body, { images: 'omit' });
  let sharedDocument = parseMarkdown(sharedBody, { frontmatter: false });
  let descriptionContainsImage = false;
  walkMarkdownTree(sharedDocument, (node) => {
    if (node.type === 'image' || node.type === 'imageReference') descriptionContainsImage = true;
    if (node.type === 'imageReference') imageReferences.add(node.identifier);
    if (node.type === 'linkReference') linkReferences.add(node.identifier);
  });
  // HTML alt text can itself look like Markdown image syntax when emitted as
  // prose. Omit those images as well, then fail visibly if any remain.
  if (descriptionContainsImage) {
    sharedBody = rewriteMarkdownReferences(sharedBody, { images: 'omit' });
    sharedDocument = parseMarkdown(sharedBody, { frontmatter: false });
    walkMarkdownTree(sharedDocument, (node) => {
      if (node.type === 'image' || node.type === 'imageReference') {
        throw new Error(
          'An image description contains image markup that cannot be shared as text.',
        );
      }
    });
  }
  if (imageReferences.size > 0) {
    // Image omission leaves reference definitions behind. Remove image-only
    // definitions too, including embedded data URLs, but retain real text links.
    const removals: Array<{ start: number; end: number }> = [];
    walkMarkdownTree(sharedDocument, (node) => {
      if (
        node.type !== 'definition' ||
        !imageReferences.has(node.identifier) ||
        linkReferences.has(node.identifier)
      ) {
        return;
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) {
        throw new Error('Cannot locate an image reference in the shared document.');
      }
      removals.push({ start, end });
    });
    for (const { start, end } of removals.sort((a, b) => b.start - a.start)) {
      sharedBody = sharedBody.slice(0, start) + sharedBody.slice(end);
    }
  }
  return (frontmatter ?? '') + sharedBody;
}

/** Share text and formatting only, retaining image descriptions instead of images. */
export async function createSharedDocumentArchive(
  markdown: string,
  selectedFile: string | null,
): Promise<Uint8Array> {
  // The parser applies its own source/complexity limits before transformation;
  // the smaller share-link budget applies to the resulting text.
  const sharedMarkdown = await omitSharedImages(markdown);
  const encoded = new TextEncoder().encode(sharedMarkdown);
  if (encoded.byteLength > SHARED_DOCUMENT_LIMITS.markdownBytes) {
    throw new Error(
      `This document is too large for a shared URL (maximum ${SHARED_DOCUMENT_LIMITS.markdownBytes.toLocaleString()} UTF-8 bytes).`,
    );
  }

  const [{ MemoryContentContainer }, { containerToZip }] = await Promise.all([
    import('@bendyline/squisq/storage'),
    import('@bendyline/squisq-formats/container'),
  ]);
  const container = new MemoryContentContainer();
  await container.writeFile(sharedDocumentFilename(selectedFile), encoded, 'text/markdown');
  const blob = await containerToZip(container, { compression: 'DEFLATE', compressionLevel: 9 });
  return new Uint8Array(await blob.arrayBuffer());
}

export function buildSharedDocumentUrl(
  baseUrl: string,
  archive: Uint8Array,
  mode: SharedDocumentMode | null,
): string {
  return createSharedDocumentUrl(resolveSharedDocumentBaseUrl(baseUrl), archive, mode);
}

/** Build the canonical public URL encoded by the QR sharing experience. */
export function buildSharedDocumentQrUrl(
  archive: Uint8Array,
  mode: SharedDocumentMode | null,
): string {
  const url = createSharedDocumentUrl(PUBLIC_DOCBLOCKS_SHARE_URL, archive, mode);
  if (url.length > SHARED_DOCUMENT_LIMITS.qrUrlCharacters) {
    throw new Error(
      'This document is too large for a reliable QR code (maximum ' +
        SHARED_DOCUMENT_LIMITS.qrUrlCharacters.toLocaleString() +
        ' URL characters). Copy the share link instead.',
    );
  }
  return url;
}

export function sharedDocumentQrFilename(selectedFile: string | null): string {
  return sharedDocumentFilename(selectedFile).replace(/\.md$/iu, '-qr.png');
}
