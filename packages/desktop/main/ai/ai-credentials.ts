/**
 * Where DocBlocks keeps its Gezel grant between launches: an owner-only file
 * under userData.
 *
 * DocBlocks deliberately does not use Electron's `safeStorage` (the macOS
 * Keychain, Windows DPAPI, or a Linux keyring) for it. Gezel itself keeps its
 * scoped first-party client credential (`runtime/auth-token`) and the bearer
 * tokens it issues to apps (`tokens.json`) in owner-only files, so a reader
 * able to open this file can already take credentials of equal or broader
 * authority from Gezel's directory. A keychain item would protect nothing
 * here, yet every change of the reading app's code signature — a development
 * Electron, an ad hoc local build, the Mac App Store beside the Developer ID
 * build — would cost the person a keychain password prompt.
 *
 * Earlier development builds wrote `safeStorage` ciphertext to the same path.
 * It fails the token check, reads as "not connected", and the next connection
 * overwrites it — without ever asking the keychain to decrypt it.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AiCredentialStore } from './gezel-connector.js';

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const MAX_TOKEN_CHARACTERS = 4096;

/** Bearer tokens are printable ASCII without whitespace. */
function isPlausibleToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOKEN_CHARACTERS && /^[\x21-\x7e]+$/u.test(value);
}

export class OwnerOnlyFileCredentialStore implements AiCredentialStore {
  private cached: string | null = null;
  private read = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<string | null> {
    if (this.read) return this.cached;
    this.read = true;
    try {
      const data = await readFile(this.filePath);
      if (data.byteLength === 0 || data.byteLength > MAX_CREDENTIAL_FILE_BYTES) return null;
      const token = data.toString('utf8');
      this.cached = isPlausibleToken(token) ? token : null;
    } catch {
      // Missing or unreadable: "not connected", which one click fixes.
      this.cached = null;
    }
    return this.cached;
  }

  async save(token: string): Promise<void> {
    if (!isPlausibleToken(token)) throw new Error('Refusing to store a malformed credential');
    this.cached = token;
    this.read = true;
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, token, { mode: 0o600 });
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async delete(): Promise<void> {
    this.cached = null;
    this.read = true;
    await rm(this.filePath, { force: true });
  }
}
