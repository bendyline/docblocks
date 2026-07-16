import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';

const MEDIA_MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  png: 'image/png',
  svg: 'image/svg+xml',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
};

export interface ParsedMediaRef {
  key: string;
  suffix: string;
}

export type ParsedDocumentResourcePath = { kind: 'document' } | { kind: 'media'; key: string };

export function mediaSidecarFolder(markdownBasename: string): string {
  const stem = markdownBasename.replace(/\.[^.]+$/, '');
  return `${stem}_files`;
}

export function parseMediaRef(ref: string, markdownBasename: string): ParsedMediaRef | null {
  if (
    !isBoundedString(ref, HOST_WIRE_LIMITS.pathCharacters, 1) ||
    !isBoundedString(markdownBasename, 255, 1)
  ) {
    return null;
  }
  const splitAt = ref.search(/[?#]/);
  const pathPart = splitAt === -1 ? ref : ref.slice(0, splitAt);
  const suffix = splitAt === -1 ? '' : ref.slice(splitAt);
  const cleanPath = pathPart.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanPath) return null;

  const sidecar = mediaSidecarFolder(markdownBasename);
  const key = cleanPath.startsWith(sidecar + '/') ? cleanPath : `${sidecar}/${cleanPath}`;
  const segments = key.split('/').map(decodeSegment);
  if (segments.some((segment) => !isSafeSegment(segment))) return null;
  const normalizedKey = segments.join('/');
  if (normalizedKey.length > HOST_WIRE_LIMITS.pathCharacters) return null;
  if (normalizedKey.toLowerCase().endsWith('.md')) return null;

  return { key: normalizedKey, suffix };
}

export function parseDocumentResourcePath(
  requestedPath: string,
  markdownBasename: string,
): ParsedDocumentResourcePath | null {
  if (
    !isBoundedString(requestedPath, HOST_WIRE_LIMITS.pathCharacters, 1) ||
    !isBoundedString(markdownBasename, 255, 1)
  ) {
    return null;
  }
  const splitAt = requestedPath.search(/[?#]/);
  const pathPart = splitAt === -1 ? requestedPath : requestedPath.slice(0, splitAt);
  const normalized = pathPart.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized && !normalized.includes('/')) {
    try {
      if (decodeURIComponent(normalized) === markdownBasename) return { kind: 'document' };
    } catch {
      return null;
    }
  }

  const media = parseMediaRef(requestedPath, markdownBasename);
  return media ? { kind: 'media', key: media.key } : null;
}

export function guessMediaMimeType(path: string): string {
  const cleanPath = path.split(/[?#]/, 1)[0] ?? path;
  const dot = cleanPath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = cleanPath.slice(dot + 1).toLowerCase();
  return MEDIA_MIME_TYPES[ext] ?? 'application/octet-stream';
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isSafeSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    segment.length <= 255 &&
    segment.trim() === segment &&
    !segment.endsWith('.') &&
    !/[\\/:]/.test(segment) &&
    !hasControlCharacter(segment)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
