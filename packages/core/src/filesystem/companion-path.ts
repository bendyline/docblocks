import { parseWorkspacePath } from './workspace-path.js';

/** Return the hidden companion directory used for a document's media and versions. */
export function documentCompanionPath(documentPath: string): string {
  const rooted = documentPath.replace(/\\/g, '/').startsWith('/');
  const clean = parseWorkspacePath(documentPath);
  if (!clean) throw new Error('The workspace root has no document companion path.');
  const slash = clean.lastIndexOf('/');
  const parent = slash < 0 ? '' : clean.slice(0, slash);
  const name = (slash < 0 ? clean : clean.slice(slash + 1)).replace(/\.[^.]+$/, '');
  if (parent) return `${parent}/${name}_files`;
  return rooted ? `/${name}_files` : `${name}_files`;
}

/**
 * Image files Squisq's image editor can save back over themselves (PNG,
 * JPEG, WebP). GIF, SVG, AVIF, BMP, and ICO open read-only.
 */
export function isEditableImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp)$/i.test(path);
}

/**
 * The hidden companion that holds an image file's editing layers:
 * `photo.png` → `photo.png_files/`. It keeps the whole file name, unlike a
 * document's companion, so `photo.png`, `photo.jpg`, and `photo.md` in one
 * folder never share one. The `_files` suffix keeps it out of the explorer,
 * catalog, and index like any other companion.
 */
export function imageEditCompanionPath(imagePath: string): string {
  const rooted = imagePath.replace(/\\/g, '/').startsWith('/');
  const clean = parseWorkspacePath(imagePath);
  if (!clean) throw new Error('The workspace root has no image companion path.');
  return rooted ? `/${clean}_files` : `${clean}_files`;
}
