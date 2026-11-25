/**
 * Files kept with a document: written into its companion folder
 * (`Note.md` → `Note_files/`), the same place the editor keeps a document's
 * images, and referenced from the Markdown by a path relative to the
 * document, so the file still shows outside DocBlocks.
 */

import { fileStemForTitle } from '@bendyline/docblocks/folders';

/** What an attachment needs to be stored: a `File` has all of it. */
export interface AttachmentFile {
  readonly name: string;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Extensions for files that arrive without a usable name (a pasted screenshot). */
const EXTENSION_FOR_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp)$/i;

/** True for a file Markdown can show inline as a picture. */
export function isImageAttachment(file: Pick<AttachmentFile, 'name' | 'type'>): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name);
}

/**
 * A file name safe on every storage DocBlocks writes to. The stem is cleaned
 * the way a typed title is; the extension keeps only letters and digits.
 */
export function attachmentFileName(file: Pick<AttachmentFile, 'name' | 'type'>): string {
  const name = file.name.slice(file.name.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const rawStem = dot > 0 ? name.slice(0, dot) : name;
  const rawExtension = dot > 0 ? name.slice(dot + 1) : '';
  const extension =
    rawExtension.replace(/[^a-z0-9]/gi, '').toLowerCase() || EXTENSION_FOR_TYPE[file.type] || '';
  const stem = fileStemForTitle(rawStem) || (isImageAttachment(file) ? 'image' : 'attachment');
  return extension ? `${stem}.${extension}` : stem;
}

/**
 * The Markdown that shows `relativePath`: a picture for an image, a link for
 * anything else. A path with spaces or brackets uses the `<…>` form.
 */
export function attachmentReference(
  file: Pick<AttachmentFile, 'name' | 'type'>,
  relativePath: string,
): string {
  const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const destination = /[\s()<>]/.test(relativePath)
    ? `<${relativePath.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
    : relativePath;
  if (isImageAttachment(file)) {
    const alt = fileName.replace(/\.[^.]+$/, '').replace(/[[\]\\]/g, '');
    return `![${alt}](${destination})`;
  }
  return `[${fileName.replace(/[[\]\\]/g, '')}](${destination})`;
}
