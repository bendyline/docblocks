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

/** Create a compressed DBK containing exactly one bounded Markdown file. */
export async function createSharedDocumentArchive(
  markdown: string,
  selectedFile: string | null,
): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(markdown);
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
