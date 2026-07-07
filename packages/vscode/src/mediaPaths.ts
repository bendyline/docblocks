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

export function mediaSidecarFolder(markdownBasename: string): string {
  return markdownBasename.replace(/\.[^.]+$/, '') + '_files';
}

export function parseMediaRef(ref: string, markdownBasename: string): ParsedMediaRef | null {
  const splitAt = ref.search(/[?#]/);
  const pathPart = splitAt === -1 ? ref : ref.slice(0, splitAt);
  const suffix = splitAt === -1 ? '' : ref.slice(splitAt);
  const cleanPath = pathPart.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanPath) return null;

  const sidecar = mediaSidecarFolder(markdownBasename);
  const key = cleanPath.startsWith(sidecar + '/') ? cleanPath : `${sidecar}/${cleanPath}`;
  const segments = key.split('/').map(decodeSegment);
  if (segments.some((segment) => !isSafeSegment(segment))) return null;

  return { key: segments.join('/'), suffix };
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
  return segment !== '' && segment !== '.' && segment !== '..' && !/[\\/\0]/.test(segment);
}
