/**
 * Persistent updater log.
 *
 * electron-updater logs to `console` by default, which a packaged Windows or
 * macOS app discards, and updater-result.ts deliberately reduces failures to
 * generic copy. This keeps electron-updater's own log — including the raw
 * stack of every `error` event — in `<logs>/updater.log` so a failed update
 * can be diagnosed after the fact. On Windows that is
 * %APPDATA%\docblocks-desktop\logs\updater.log.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import type { Logger } from 'electron-updater';

export const UPDATER_LOG_FILE = 'updater.log';
export const PREVIOUS_UPDATER_LOG_FILE = 'updater.previous.log';
const MAX_UPDATER_LOG_BYTES = 1024 * 1024;

export function createUpdaterLog(directory: string, now: () => Date = () => new Date()): Logger {
  const file = path.join(directory, UPDATER_LOG_FILE);
  try {
    mkdirSync(directory, { recursive: true });
    // Keep one previous log instead of growing without bound.
    if (statSync(file).size > MAX_UPDATER_LOG_BYTES) {
      renameSync(file, path.join(directory, PREVIOUS_UPDATER_LOG_FILE));
    }
  } catch {
    // No log yet, or the folder is unwritable — write() copes with both.
  }

  const write = (level: string, message: unknown): void => {
    try {
      appendFileSync(file, `${now().toISOString()} ${level} ${format(message)}\n`, 'utf8');
    } catch {
      // Logging must never break an update.
    }
  };

  return {
    info: (message?: unknown) => write('INFO', message),
    warn: (message?: unknown) => write('WARN', message),
    error: (message?: unknown) => write('ERROR', message),
  };
}
