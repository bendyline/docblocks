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

export interface AtomicSettingsWriteOptions {
  maxRenameAttempts?: number;
  retryDelay?: (attempt: number) => Promise<void>;
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
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(file);
  } catch (error: unknown) {
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
  if (bytes.byteLength > SETTINGS_MAX_BYTES) {
    throw new Error(`Desktop settings exceed the ${SETTINGS_MAX_BYTES}-byte limit`);
  }
  const raw = decodeUtf8Text(bytes, { label: 'Desktop settings', path: file });
  return parseSettings(JSON.parse(raw) as unknown);
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

  const maxAttempts = options.maxRenameAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Invalid settings rename attempt limit.');
  }
  const retryDelay =
    options.retryDelay ??
    ((attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, 50 * attempt)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await io.rename(tmp, file);
      return;
    } catch (error: unknown) {
      if (attempt === maxAttempts || !isRetryableRenameError(error)) throw error;
      await retryDelay(attempt);
    }
  }
}

function isRetryableRenameError(error: unknown): boolean {
  return ['EACCES', 'EBUSY', 'EPERM'].some((code) => isNodeErrorCode(error, code));
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
