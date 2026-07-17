import { HOST_WIRE_LIMITS, isBoundedString, parseExternalHttpUrl } from '@bendyline/docblocks/host';

export type ShellEditorLinkTarget =
  | { readonly kind: 'fragment' }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'workspace'; readonly path: string };

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdown)$/iu;

/**
 * Classify a link authored in the editor without treating its path as
 * filesystem authority. External navigation is limited to canonical HTTP(S)
 * URLs, while relative Markdown paths are resolved inside the active
 * workspace and cannot traverse above its root.
 */
export function resolveShellEditorLinkTarget(
  href: string,
  documentPath: string | null,
): ShellEditorLinkTarget | null {
  if (!isBoundedString(href, HOST_WIRE_LIMITS.urlCharacters, 1)) return null;
  if (href.startsWith('#')) return { kind: 'fragment' };

  const externalUrl = parseExternalHttpUrl(href);
  if (externalUrl) return { kind: 'external', url: externalUrl };
  if (documentPath === null || href.startsWith('//') || URI_SCHEME.test(href)) return null;

  const splitAt = href.search(/[?#]/u);
  const encodedPath = splitAt === -1 ? href : href.slice(0, splitAt);
  if (!encodedPath) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (decodedPath.includes('\\') || hasControlCharacter(decodedPath)) return null;

  const documentSegments = normalizeDocumentPath(documentPath);
  if (!documentSegments) return null;
  const targetSegments = decodedPath.startsWith('/') ? [] : documentSegments.slice(0, -1);

  for (const segment of decodedPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (targetSegments.length === 0) return null;
      targetSegments.pop();
      continue;
    }
    if (segment.length > 255) return null;
    targetSegments.push(segment);
  }

  const path = targetSegments.join('/');
  if (!path || path.length > HOST_WIRE_LIMITS.pathCharacters || !MARKDOWN_EXTENSION.test(path)) {
    return null;
  }
  return { kind: 'workspace', path };
}

function normalizeDocumentPath(path: string): string[] | null {
  if (!isBoundedString(path, HOST_WIRE_LIMITS.pathCharacters, 1)) return null;
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' || segment.length > 255 || hasControlCharacter(segment)) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments : null;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
