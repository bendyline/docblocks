/**
 * Differential-update base check.
 *
 * electron-updater builds a new installer out of the previous one: blocks the
 * two versions' blockmaps share are copied from the installer cached at
 * install time, and only the rest is downloaded. It never checks that the
 * cached installer is the file its blockmap describes. When it is some other
 * file, the copied blocks are wrong, the rebuilt installer fails its SHA-512
 * once the partial download has finished, and the installer is then downloaded
 * whole as well: the update counts to 100% twice.
 *
 * That is the state after running an installer other than the one the feed
 * assumes (a per-architecture installer under the combined feed or the
 * reverse, a manual install over an updated copy) and after an update that
 * was downloaded but never installed. A file of a different size cannot be the
 * one a blockmap describes, so the sizes are compared before a differential
 * download, and a mismatch downloads the installer whole, once.
 */

import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

/** electron-updater's name for the blockmap it keeps beside the cached installer. */
export const CACHED_BLOCKMAP_FILE = 'current.blockmap';

/** A 1.4 GB installer's blockmap is 1.5 MB compressed and 2.2 MB of JSON. */
export const MAX_COMPRESSED_BLOCKMAP_BYTES = 32 * 1024 * 1024;
const MAX_BLOCKMAP_JSON_BYTES = 128 * 1024 * 1024;

export interface DifferentialBaseSources {
  /** The installer electron-updater would copy unchanged blocks from. */
  readonly installerPath: string;
  /** The blockmap electron-updater cached for that installer and prefers over the published one. */
  readonly cachedBlockMapPath: string;
  /** Downloads the gzip-compressed blockmap published for the running version's installer. */
  readonly fetchPublishedBlockMap: () => Promise<Uint8Array>;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The size in bytes of the file a blockmap describes, or null when the value is not a blockmap. */
export function blockMapFileSize(blockMap: unknown): number | null {
  if (!isRecord(blockMap) || !Array.isArray(blockMap.files) || blockMap.files.length === 0) {
    return null;
  }
  let end = 0;
  for (const file of blockMap.files as readonly unknown[]) {
    if (!isRecord(file) || !isByteCount(file.offset) || !Array.isArray(file.sizes)) return null;
    let fileEnd = file.offset;
    for (const size of file.sizes as readonly unknown[]) {
      if (!isByteCount(size)) return null;
      fileEnd += size;
    }
    end = Math.max(end, fileEnd);
  }
  return end;
}

function parseBlockMap(compressed: Uint8Array): unknown {
  if (compressed.byteLength > MAX_COMPRESSED_BLOCKMAP_BYTES) {
    throw new Error(
      `Blockmap is ${compressed.byteLength} bytes; at most ${MAX_COMPRESSED_BLOCKMAP_BYTES} are read.`,
    );
  }
  const json = gunzipSync(compressed, { maxOutputLength: MAX_BLOCKMAP_JSON_BYTES });
  return JSON.parse(json.toString('utf8'));
}

/** electron-updater treats a cached blockmap it cannot read as absent, and so does this. */
async function readCachedBlockMap(file: string): Promise<unknown> {
  try {
    return parseBlockMap(await readFile(file));
  } catch {
    return null;
  }
}

async function fileSize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Why the cached installer cannot seed a differential download, or null when
 * it can. The blockmap consulted is the one electron-updater would use: the
 * cached one when it is readable, otherwise the published one.
 *
 * Rejects when the check itself cannot run. electron-updater's own attempt is
 * still safe then, only possibly wasteful.
 */
export async function differentialBaseProblem(
  sources: DifferentialBaseSources,
): Promise<string | null> {
  const installerSize = await fileSize(sources.installerPath);
  if (installerSize === null) return 'no installer is cached';

  const blockMap =
    (await readCachedBlockMap(sources.cachedBlockMapPath)) ??
    parseBlockMap(await sources.fetchPublishedBlockMap());
  const describedSize = blockMapFileSize(blockMap);
  if (describedSize === null) return 'the cached installer has no usable blockmap';
  if (describedSize !== installerSize) {
    return `the cached installer is ${installerSize} bytes and its blockmap describes ${describedSize}`;
  }
  return null;
}
