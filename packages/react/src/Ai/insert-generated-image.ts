/**
 * Save a generated image beside the document and write the Markdown that
 * shows it. Shared by the image panel and Illustrate's design graphics.
 *
 * The bytes go to the document's `<stem>_files/` folder through the media
 * provider, which overwrites a file of the same name, so every name carries
 * the seed and a time stamp: a regenerated image never replaces one already
 * in the document.
 */

import { createDocument, stringifyMarkdown } from '@bendyline/squisq/markdown';

export interface GeneratedImageMedia {
  addMedia(name: string, data: ArrayBuffer | Blob | Uint8Array, mimeType: string): Promise<string>;
}

const SLUG_WORDS = 6;
const SLUG_CHARACTERS = 40;
const ALT_CHARACTERS = 160;

/** A short, filesystem-safe summary of the prompt. */
export function imageSlug(prompt: string): string {
  const words = prompt
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .slice(0, SLUG_WORDS);
  const slug = words.join('-').slice(0, SLUG_CHARACTERS).replace(/-+$/u, '');
  return slug || 'image';
}

export function generatedImageName(prompt: string, seed: number, now = Date.now()): string {
  return `generated-${imageSlug(prompt)}-${String(seed)}-${now.toString(36)}.png`;
}

/** One line, cut at a word boundary: alt text describes, it does not reproduce the prompt. */
export function imageAltText(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  if (line.length <= ALT_CHARACTERS) return line;
  const cut = line.slice(0, ALT_CHARACTERS - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > ALT_CHARACTERS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The Markdown block for an image, escaped by the same serializer the editor uses. */
export function imageMarkdown(path: string, alt: string): string {
  return stringifyMarkdown(
    createDocument({
      type: 'paragraph',
      children: [{ type: 'image', url: path, alt: imageAltText(alt) }],
    } as never),
  ).trim();
}

/** Write the PNG into the document's media folder; returns the path Markdown references. */
export async function saveGeneratedImage(
  media: GeneratedImageMedia,
  image: { readonly data: ArrayBuffer; readonly seed: number },
  prompt: string,
  now = Date.now(),
): Promise<string> {
  return media.addMedia(generatedImageName(prompt, image.seed, now), image.data, 'image/png');
}
