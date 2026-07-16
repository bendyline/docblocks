import { HOST_WIRE_LIMITS, isBoundedString, parseExternalHttpUrl } from '@bendyline/docblocks/host';

export type EditorLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'workspace'; path: string };

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Classify an editor href without giving the webview filesystem authority.
 * Local paths are resolved from the active document and must remain inside
 * its VS Code workspace folder. The returned path is canonical and relative
 * to that folder; the extension host supplies the actual workspace URI.
 */
export function resolveEditorLinkTarget(
  href: string,
  documentWorkspacePath: string | null,
): EditorLinkTarget | null {
  if (!isBoundedString(href, HOST_WIRE_LIMITS.urlCharacters, 1)) return null;

  const externalUrl = parseExternalHttpUrl(href);
  if (externalUrl) return { kind: 'external', url: externalUrl };
  if (documentWorkspacePath === null || href.startsWith('//') || URI_SCHEME.test(href)) {
    return null;
  }

  const splitAt = href.search(/[?#]/);
  const encodedPath = splitAt === -1 ? href : href.slice(0, splitAt);
  if (!encodedPath) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (decodedPath.includes('\\') || hasControlCharacter(decodedPath)) return null;

  const documentSegments = normalizeDocumentWorkspacePath(documentWorkspacePath);
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
  return path && path.length <= HOST_WIRE_LIMITS.pathCharacters
    ? { kind: 'workspace', path }
    : null;
}

function normalizeDocumentWorkspacePath(path: string): string[] | null {
  if (!isBoundedString(path, HOST_WIRE_LIMITS.pathCharacters, 1)) return null;
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' || hasControlCharacter(segment)) return null;
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
