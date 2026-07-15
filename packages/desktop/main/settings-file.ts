import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeUtf8Text } from '@bendyline/docblocks/filesystem';
import { SETTINGS_MAX_BYTES, parseSettings, type Settings } from './settings-schema.js';

export interface SettingsFileIo {
  readFile(file: string): Promise<Uint8Array>;
  mkdir(directory: string): Promise<unknown>;
  writeFile(file: string, contents: string): Promise<unknown>;
  rename(source: string, destination: string): Promise<unknown>;
}

export interface SettingsRenameOptions {
  maxRenameAttempts?: number;
  retryDelay?: (attempt: number) => Promise<void>;
}

export type AtomicSettingsWriteOptions = SettingsRenameOptions;

export interface RecoverSettingsFileOptions extends SettingsRenameOptions {
  /** Injected clock — the quarantine name is timestamped. */
  now?: () => Date;
}

/** Why the persisted settings file could not be used this launch. */
export type SettingsRecoveryKind = 'unusable-content' | 'unreadable';

export interface SettingsRecovery {
  kind: SettingsRecoveryKind;
  /** The failure that made the file unusable. */
  reason: string;
  /** Where the original bytes were preserved, when quarantine succeeded. */
  quarantinePath?: string;
  /** Why the original could not be moved aside, when quarantine failed. */
  quarantineFailure?: string;
}

export interface SettingsReadResult {
  /** Null when there is nothing usable on disk; the caller applies defaults. */
  settings: Settings | null;
  /** Present only when an existing file had to be abandoned. */
  recovery?: SettingsRecovery;
}

const NODE_SETTINGS_IO: SettingsFileIo = {
  readFile: (file) => fs.readFile(file),
  mkdir: (directory) => fs.mkdir(directory, { recursive: true }),
  writeFile: (file, contents) => fs.writeFile(file, contents, 'utf8'),
  rename: (source, destination) => fs.rename(source, destination),
};

export async function readSettingsFile(
  file: string,
  io: SettingsFileIo = NODE_SETTINGS_IO,
): Promise<Settings | null> {
  const bytes = await readSettingsBytes(file, io);
  if (bytes === null) return null;
  return parseSettingsBytes(bytes, file);
}

/**
 * Read settings without ever failing the caller.
 *
 * Launch must not depend on the settings file being intact: `createWindow()`
 * runs after this read, so any throw here means the user gets no window, no
 * error, and no recovery path short of finding and deleting the file by hand.
 *
 * The two failure classes are deliberately handled differently:
 *
 *  • **Unusable content** (oversized, not UTF-8, not JSON, schema-invalid) can
 *    never become valid settings, and leaving it in place would re-break every
 *    subsequent launch. The original bytes are moved aside to a timestamped
 *    `.corrupt` sibling — preserved rather than destroyed — which also clears
 *    the path for the next write.
 *  • **Unreadable** (a lock, a permission fault, failing hardware) says nothing
 *    about the content, and such faults are usually transient. Moving the file
 *    aside would turn a temporary problem into permanent settings loss, so the
 *    file is left completely untouched and this session simply runs on
 *    defaults. `atomicWriteSettingsFile` already retries locked renames, so a
 *    later write is not blocked by the file either.
 */
export async function readSettingsFileWithRecovery(
  file: string,
  io: SettingsFileIo = NODE_SETTINGS_IO,
  options: RecoverSettingsFileOptions = {},
): Promise<SettingsReadResult> {
  let bytes: Uint8Array | null;
  try {
    bytes = await readSettingsBytes(file, io);
  } catch (error: unknown) {
    return { settings: null, recovery: { kind: 'unreadable', reason: errorMessage(error) } };
  }
  if (bytes === null) return { settings: null };

  try {
    return { settings: parseSettingsBytes(bytes, file) };
  } catch (error: unknown) {
    return {
      settings: null,
      recovery: {
        kind: 'unusable-content',
        reason: errorMessage(error),
        ...(await quarantineSettingsFile(file, io, options)),
      },
    };
  }
}

/** ENOENT is absence, not failure; every other read error belongs to the caller. */
async function readSettingsBytes(file: string, io: SettingsFileIo): Promise<Uint8Array | null> {
  try {
    return await io.readFile(file);
  } catch (error: unknown) {
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function parseSettingsBytes(bytes: Uint8Array, file: string): Settings {
  if (bytes.byteLength > SETTINGS_MAX_BYTES) {
    throw new Error(`Desktop settings exceed the ${SETTINGS_MAX_BYTES}-byte limit`);
  }
  const raw = decodeUtf8Text(bytes, { label: 'Desktop settings', path: file });
  return parseSettings(JSON.parse(raw) as unknown);
}

/**
 * Move an unusable settings file aside, preserving the original bytes.
 * Best effort by design: failing to preserve the file must never become the
 * reason the app has no window.
 */
async function quarantineSettingsFile(
  file: string,
  io: SettingsFileIo,
  options: RecoverSettingsFileOptions,
): Promise<Pick<SettingsRecovery, 'quarantinePath' | 'quarantineFailure'>> {
  // Timestamped rather than a single `.corrupt` slot: a second corruption must
  // not overwrite — and destroy — the first file preserved for the user.
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/gu, '-');
  const quarantinePath = `${file}.${stamp}.corrupt`;
  try {
    await renameWithRetry(io, file, quarantinePath, options);
    return { quarantinePath };
  } catch (error: unknown) {
    return { quarantineFailure: errorMessage(error) };
  }
}

export async function atomicWriteSettingsFile(
  file: string,
  contents: string,
  io: SettingsFileIo = NODE_SETTINGS_IO,
  options: AtomicSettingsWriteOptions = {},
): Promise<void> {
  const tmp = `${file}.tmp`;
  await io.mkdir(path.dirname(file));
  await io.writeFile(tmp, contents);
  await renameWithRetry(io, tmp, file, options);
}

/** Rename, riding out the transient sharing violations Windows is prone to. */
async function renameWithRetry(
  io: SettingsFileIo,
  source: string,
  destination: string,
  options: SettingsRenameOptions,
): Promise<void> {
  const maxAttempts = options.maxRenameAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Invalid settings rename attempt limit.');
  }
  const retryDelay =
    options.retryDelay ??
    ((attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, 50 * attempt)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await io.rename(source, destination);
      return;
    } catch (error: unknown) {
      if (attempt === maxAttempts || !isRetryableRenameError(error)) throw error;
      await retryDelay(attempt);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableRenameError(error: unknown): boolean {
  return ['EACCES', 'EBUSY', 'EPERM'].some((code) => isNodeErrorCode(error, code));
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
