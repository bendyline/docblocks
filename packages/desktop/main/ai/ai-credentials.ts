/**
 * Where DocBlocks keeps its Gezel grant between launches.
 *
 * The token is encrypted with Electron's `safeStorage` (Keychain on macOS,
 * DPAPI on Windows) and written as an owner-only file under userData. When
 * encryption is unavailable the token lives in memory for the session only,
 * and the next launch asks the user to connect again — a missing keychain
 * must never turn into a plaintext credential on disk.
 *
 * Linux is started with `--password-store=basic` (see
 * `linux-credential-storage.ts`), so there `safeStorage` obscures rather than
 * protects. That is accepted deliberately for this token: it grants inference
 * only, and it sits beside Gezel's own runtime directory, whose owner-only
 * files already carry a credential with far broader authority to the same
 * reader.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AiCredentialStore } from './gezel-connector.js';

export interface CredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const MAX_TOKEN_CHARACTERS = 4096;

/** Bearer tokens are printable ASCII without whitespace. */
function isPlausibleToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOKEN_CHARACTERS && /^[\x21-\x7e]+$/u.test(value);
}

export class EncryptedFileCredentialStore implements AiCredentialStore {
  private cached: string | null = null;
  private read = false;

  constructor(
    private readonly filePath: string,
    private readonly encryption: CredentialEncryption,
  ) {}

  async load(): Promise<string | null> {
    if (this.read) return this.cached;
    this.read = true;
    if (!this.encryption.isEncryptionAvailable()) return this.cached;
    try {
      const data = await readFile(this.filePath);
      if (data.byteLength === 0 || data.byteLength > MAX_CREDENTIAL_FILE_BYTES) return null;
      const token = this.encryption.decryptString(data);
      this.cached = isPlausibleToken(token) ? token : null;
    } catch {
      // Missing, unreadable, or encrypted under a key this install no longer
      // has: all mean "not connected", which the user can fix with one click.
      this.cached = null;
    }
    return this.cached;
  }

  async save(token: string): Promise<void> {
    if (!isPlausibleToken(token)) throw new Error('Refusing to store a malformed credential');
    this.cached = token;
    this.read = true;
    if (!this.encryption.isEncryptionAvailable()) return;
    const encrypted = this.encryption.encryptString(token);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, encrypted, { mode: 0o600 });
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
