import { HOST_WIRE_LIMITS, isBoundedString, parseExternalHttpUrl } from '@bendyline/docblocks/host';

export type EditorLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'workspace'; path: string }
  | { kind: 'external-or-workspace'; url: string; path: string };

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const SCHEMELESS_WEB_URL =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{3,63}(?::[0-9]{1,5})?(?:[/?#][^\s\\]*)?$/;
const WORKSPACE_FILE_EXTENSIONS = new Set([
  'avif',
  'bash',
  'bmp',
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'css',
  'csv',
  'dbk',
  'doc',
  'docx',
  'epub',
  'exe',
  'gif',
  'gz',
  'h',
  'hpp',
  'htm',
  'html',
  'ico',
  'ini',
  'java',
  'jpeg',
  'jpg',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'kts',
  'less',
  'lua',
  'markdown',
  'md',
  'mdown',
  'mjs',
  'mov',
  'mp3',
  'mp4',
  'odp',
  'ods',
  'odt',
  'pdf',
  'php',
  'png',
  'ppt',
  'pptx',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svg',
  'swift',
  'tar',
  'tgz',
  'toml',
  'ts',
  'tsx',
  'txt',
  'wasm',
  'wav',
  'webm',
  'webp',
  'xml',
  'xls',
  'xlsx',
  'yaml',
  'yml',
  'zsh',
  'zip',
]);

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
  const schemeLessExternalUrl = parseSchemeLessExternalHttpUrl(href);
  if (documentWorkspacePath === null || href.startsWith('//') || URI_SCHEME.test(href)) {
    return schemeLessExternalUrl ? { kind: 'external', url: schemeLessExternalUrl } : null;
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
  if (!path || path.length > HOST_WIRE_LIMITS.pathCharacters) return null;
  return schemeLessExternalUrl
    ? { kind: 'external-or-workspace', url: schemeLessExternalUrl, path }
    : { kind: 'workspace', path };
}

/**
 * Recognize only unambiguous, ASCII domain-shaped hrefs without a scheme.
 * The inferred destination is always HTTPS and is re-run through the shared
 * external-navigation policy. Common editor file extensions remain local;
 * an existing domain-shaped workspace entry gets final precedence in the
 * privileged host.
 */
function parseSchemeLessExternalHttpUrl(href: string): string | null {
  if (!SCHEMELESS_WEB_URL.test(href)) return null;
  const suffixStart = href.search(/[/?#]/);
  const authority = suffixStart === -1 ? href : href.slice(0, suffixStart);
  const hostname = authority.replace(/:[0-9]{1,5}$/, '');
  const extension = hostname.slice(hostname.lastIndexOf('.') + 1).toLowerCase();
  if (hostname.length > 253 || WORKSPACE_FILE_EXTENSIONS.has(extension)) return null;
  return parseExternalHttpUrl(`https://${href}`);
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
