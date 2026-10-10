import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpeechModelInfo } from '@bendyline/docblocks/host';
import { VerifiedDownloadError } from './verified-download.js';

import {
  SPEECH_MODEL_CATALOG,
  SpeechAssetStore,
  type SpeechAssetOptions,
  downloadBytes,
  type SpeechModelEntry,
} from '@bendyline/gezel/speech-models';
export {
  SPEECH_MODEL_CATALOG,
  KOKORO_MODEL_ID,
  KOKORO_DEFAULT_VOICE,
  KOKORO_SAMPLE_RATE,
  KOKORO_VOICES,
  KOKORO_VOICE_BYTES,
  KOKORO_MODEL_FILE,
  catalogEntry,
  downloadBytes,
  type SpeechModelEntry,
  type SpeechModelFile,
} from '@bendyline/gezel/speech-models';

interface Manifest {
  readonly id: string;
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
  readonly installedAt: string;
}

function matchesPins(manifest: Manifest, entry: SpeechModelEntry): boolean {
  return (
    manifest.files.length === entry.files.length &&
    entry.files.every((file) =>
      manifest.files.some((saved) => saved.name === file.name && saved.sha256 === file.sha256),
    )
  );
}

/** Absolute paths of an installed model's files, keyed by catalog file name. */
export interface LocatedModel {
  readonly entry: SpeechModelEntry;
  readonly source: 'app' | 'shared';
  readonly files: Readonly<Record<string, string>>;
}

export interface SpeechModelStoreOptions {
  /** `<userData>/speech/models`. */
  readonly root: string;
  /** Home directory to look for shared copies in, or null to never look (MAS). */
  readonly sharedHome: string | null;
  readonly assets?: SpeechAssetOptions;
  readonly fetchImpl?: typeof fetch;
  /** Injected by tests; production always uses the pinned catalog. */
  readonly catalog?: readonly SpeechModelEntry[];
}

export class SpeechModelStore {
  private readonly root: string;
  private readonly assets: SpeechAssetStore;
  private readonly sharedStorage: boolean;
  readonly catalog: readonly SpeechModelEntry[];
  private readonly installing = new Map<string, Promise<void>>();

  constructor(options: SpeechModelStoreOptions) {
    this.root = options.root;
    this.sharedStorage = Boolean(options.assets?.root);
    this.assets = new SpeechAssetStore({
      root: null,
      candidates: (entry) =>
        options.sharedHome && entry.sharedPath
          ? [path.join(options.sharedHome, ...entry.sharedPath)]
          : [],
      ...options.assets,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.catalog = options.catalog ?? SPEECH_MODEL_CATALOG;
  }

  entry(id: string): SpeechModelEntry | undefined {
    return this.catalog.find((entry) => entry.id === id);
  }

  private modelDir(id: string): string {
    return path.join(this.root, id);
  }

  private filePath(id: string, name: string): string {
    return path.join(this.modelDir(id), ...name.split('/'));
  }

  private async readManifest(id: string): Promise<Manifest | null> {
    try {
      const file = path.join(this.modelDir(id), 'manifest.json');
      if ((await stat(file)).size > 64 * 1024) return null;
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof value !== 'object' || value === null) return null;
      const manifest = value as Partial<Manifest>;
      if (
        manifest.id !== id ||
        typeof manifest.installedAt !== 'string' ||
        !Array.isArray(manifest.files) ||
        manifest.files.length === 0 ||
        manifest.files.length > 256 ||
        !manifest.files.every(
          (file) =>
            file !== null &&
            typeof file === 'object' &&
            typeof file.name === 'string' &&
            file.name.length > 0 &&
            typeof file.sha256 === 'string' &&
            /^[0-9a-f]{64}$/u.test(file.sha256),
        ) ||
        new Set(manifest.files.map((file) => file.name)).size !== manifest.files.length
      )
        return null;
      return manifest as Manifest;
    } catch {
      return null;
    }
  }

  /** Installed in this app's store: the manifest matches the catalog pins and sizes. */
  private async appInstalled(entry: SpeechModelEntry): Promise<boolean> {
    const manifest = await this.readManifest(entry.id);
    if (!manifest || !matchesPins(manifest, entry)) return false;
    for (const file of entry.files) {
      try {
        if ((await stat(this.filePath(entry.id, file.name))).size !== file.size) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async sharedInstalled(entry: SpeechModelEntry): Promise<boolean> {
    for (const file of entry.files) if (!(await this.assets.find(entry, file))) return false;
    return true;
  }

  private async sourceOf(entry: SpeechModelEntry): Promise<'app' | 'shared' | null> {
    if (await this.appInstalled(entry)) return 'app';
    if (await this.sharedInstalled(entry)) return 'shared';
    return null;
  }

  async info(entry: SpeechModelEntry): Promise<SpeechModelInfo> {
    const source = await this.sourceOf(entry);
    const previous = source === null ? await this.readManifest(entry.id) : null;
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      description: entry.description,
      downloadBytes: downloadBytes(entry),
      installed: source !== null,
      ...(previous && !matchesPins(previous, entry) ? { updateRequired: true } : {}),
      source,
      ...(source === 'app' &&
      this.sharedStorage &&
      (await Promise.all(entry.files.map((file) => stat(this.filePath(entry.id, file.name))))).some(
        (info) => info.nlink > 1,
      )
        ? { sharedStorage: true }
        : {}),
      recommended: entry.recommended,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
    };
  }

  async list(): Promise<SpeechModelInfo[]> {
    return Promise.all(this.catalog.map((entry) => this.info(entry)));
  }

  /** Resolve an installed model to verified paths, or null when absent. */
  async locate(id: string): Promise<LocatedModel | null> {
    const entry = this.entry(id);
    if (!entry) return null;
    const local = await this.appInstalled(entry);
    if (!local && !(await this.sharedInstalled(entry))) return null;
    // Acquire independent file references before using a borrowed model. No
    // network access: another app removing its installation cannot break ours.
    for (const file of entry.files) {
      if (
        !(await this.assets.materialize(entry, file, this.filePath(id, file.name), {
          download: false,
        }))
      )
        return null;
    }
    if (!local) await this.writeManifest(entry);
    return {
      entry,
      source: 'app',
      files: Object.fromEntries(
        entry.files.map((file) => [file.name, this.filePath(id, file.name)]),
      ),
    };
  }

  /**
   * Download every file of a model, then write its manifest. Concurrent calls
   * for the same model share one download.
   */
  install(
    id: string,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (receivedBytes: number, totalBytes: number) => void;
    } = {},
  ): Promise<void> {
    const entry = this.entry(id);
    if (!entry) return Promise.reject(new Error(`Unknown speech model: ${id}`));
    const pending = this.installing.get(id);
    if (pending) return pending;
    const run = this.download(entry, options)
      .catch((error: unknown) => {
        if (options.signal?.aborted)
          throw new VerifiedDownloadError('aborted', 'Download cancelled.');
        throw error;
      })
      .finally(() => this.installing.delete(id));
    this.installing.set(id, run);
    return run;
  }

  private async download(
    entry: SpeechModelEntry,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (receivedBytes: number, totalBytes: number) => void;
    },
  ): Promise<void> {
    const checkCancelled = () => {
      if (options.signal?.aborted) {
        throw new VerifiedDownloadError('aborted', 'Download cancelled.');
      }
    };
    checkCancelled();
    if (await this.appInstalled(entry)) return;
    const total = downloadBytes(entry);
    let completed = 0;
    for (const file of entry.files) {
      checkCancelled();
      const destination = this.filePath(entry.id, file.name);
      await mkdir(path.dirname(destination), { recursive: true });
      await this.assets.materialize(entry, file, destination, {
        download: true,
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (received) => options.onProgress?.(completed + received, total),
      });
      completed += file.size;
      options.onProgress?.(completed, total);
    }
    checkCancelled();
    await this.writeManifest(entry, options.signal);
  }

  private async writeManifest(entry: SpeechModelEntry, signal?: AbortSignal): Promise<void> {
    const previous = await this.readManifest(entry.id);
    const manifest: Manifest = {
      id: entry.id,
      files: entry.files.map(({ name, sha256 }) => ({ name, sha256 })),
      installedAt: new Date().toISOString(),
    };
    const manifestPath = path.join(this.modelDir(entry.id), 'manifest.json');
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
      if (signal?.aborted) throw new VerifiedDownloadError('aborted', 'Download cancelled.');
      await rename(temporary, manifestPath);
    } finally {
      await rm(temporary, { force: true });
    }
    for (const file of previous?.files ?? []) {
      if (!entry.files.some((current) => current.sha256 === file.sha256))
        await this.assets.collect(file);
    }
  }

  /** Remove this app's copy. A shared copy belongs to another app and is never touched. */
  async remove(id: string): Promise<void> {
    const entry = this.entry(id);
    if (!entry) throw new Error(`Unknown speech model: ${id}`);
    const previous = await this.readManifest(id);
    await rm(this.modelDir(id), { recursive: true, force: true });
    for (const file of [...entry.files, ...(previous?.files ?? [])])
      await this.assets.collect(file);
  }
}
