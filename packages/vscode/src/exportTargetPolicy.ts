import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';

const EXPORT_EXTENSIONS = new Set(['docx', 'pdf', 'pptx', 'html', 'md', 'zip']);

export interface StoredExportTarget {
  lastUri?: string;
  byExtension?: Record<string, string>;
}

/** Parse persisted extension state without treating storage as trusted wire data. */
export function parseStoredExportTarget(value: unknown): StoredExportTarget {
  if (!isRecord(value)) return {};

  const result: StoredExportTarget = {};
  if (isBoundedString(value.lastUri, HOST_WIRE_LIMITS.urlCharacters, 1)) {
    result.lastUri = value.lastUri;
  }
  if (isRecord(value.byExtension)) {
    const entries = Object.entries(value.byExtension).slice(0, 64);
    const byExtension: Record<string, string> = {};
    for (const [extension, uri] of entries) {
      if (
        isAllowedExportExtension(extension) &&
        isBoundedString(uri, HOST_WIRE_LIMITS.urlCharacters, 1)
      ) {
        byExtension[extension] = uri;
      }
    }
    result.byExtension = byExtension;
  }
  return result;
}

/**
 * Return only a host-remembered exact target. The client controls the proposed
 * filename, so it may select an allowlisted format but may not derive sibling
 * authority from a remembered directory or `lastUri`.
 */
export function selectRememberedExactExportTarget(
  storedValue: unknown,
  requestedFilename: string,
): string | null {
  const extension = getAllowedExportExtension(requestedFilename);
  if (!extension) return null;
  const serialized = parseStoredExportTarget(storedValue).byExtension?.[extension];
  if (!serialized) return null;
  const rememberedFilename = filenameFromSerializedUri(serialized);
  return rememberedFilename && getAllowedExportExtension(rememberedFilename) === extension
    ? serialized
    : null;
}

export function getAllowedExportExtension(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  return isAllowedExportExtension(extension) ? extension : null;
}

function filenameFromSerializedUri(serialized: string): string | null {
  try {
    const uri = new URL(serialized);
    const slash = uri.pathname.lastIndexOf('/');
    const raw = slash === -1 ? uri.pathname : uri.pathname.slice(slash + 1);
    return raw ? decodeURIComponent(raw) : null;
  } catch {
    return null;
  }
}

function isAllowedExportExtension(value: string): boolean {
  return EXPORT_EXTENSIONS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
