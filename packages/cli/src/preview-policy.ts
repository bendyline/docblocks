import path from 'node:path';

export type PreviewPathPurpose = 'directory' | 'document-or-asset' | 'embedded-image';

const PREVIEW_FILE_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.htm',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.markdown',
  '.md',
  '.mjs',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
]);

const EMBEDDED_IMAGE_EXTENSIONS = new Set([
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);

const SENSITIVE_FILE_EXTENSIONS = new Set(['.cer', '.crt', '.der', '.key', '.p12', '.pem', '.pfx']);
const SENSITIVE_FILE_NAMES = new Set([
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);

/**
 * Apply the preview policy to both the name the document requested and the
 * physical path the filesystem resolved. Checking both closes symlink aliases
 * such as `images -> .private` and `diagram.png -> credentials.json`.
 */
export function isAllowedPreviewPath(
  rootPath: string,
  requestedPath: string,
  physicalPath: string,
  purpose: PreviewPathPurpose,
): boolean {
  const root = path.resolve(rootPath);
  const requested = path.resolve(requestedPath);
  const physical = path.resolve(physicalPath);

  for (const candidate of new Set([requested, physical])) {
    const relative = path.relative(root, candidate);
    if (!isContainedRelativePath(relative) || containsSensitiveSegment(relative)) return false;

    if (purpose !== 'directory') {
      const extension = path.extname(path.basename(candidate)).toLowerCase();
      const allowedExtensions =
        purpose === 'embedded-image' ? EMBEDDED_IMAGE_EXTENSIONS : PREVIEW_FILE_EXTENSIONS;
      if (!allowedExtensions.has(extension)) return false;
    }
  }

  return true;
}

function containsSensitiveSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => {
      const lower = segment.toLowerCase();
      return (
        lower.startsWith('.') ||
        SENSITIVE_FILE_NAMES.has(lower) ||
        SENSITIVE_FILE_EXTENSIONS.has(path.extname(lower))
      );
    });
}

function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}
