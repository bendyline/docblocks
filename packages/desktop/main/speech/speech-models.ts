import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpeechModelInfo, SpeechModelKind, SpeechVoiceInfo } from '@bendyline/docblocks/host';
import { verifiedDownload, verifyFile } from './verified-download.js';

/**
 * The speech model catalog and the on-disk store.
 *
 * Every file is pinned to an exact Hugging Face commit, byte length and
 * SHA-256, so a download can only ever produce the bytes reviewed here. The
 * Whisper entries match Gezel's `WHISPER_MODEL_CATALOG` and the Kokoro entry
 * matches the model and curated voices Gezel narrates with, so both products
 * hear and speak identically.
 *
 * Layout mirrors Gezel's: `<root>/<modelId>/<file>` plus a `manifest.json`
 * written last. The manifest's presence is what "installed" means; partial
 * files beside it resume on the next attempt.
 */

export interface SpeechModelFile {
  /** Path inside the model folder, `/`-separated. */
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface SpeechModelEntry {
  readonly id: string;
  readonly kind: SpeechModelKind;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly license: string;
  readonly licenseUrl: string;
  readonly files: readonly SpeechModelFile[];
  /**
   * Where Gezel keeps the same file, relative to the user's home, when it
   * downloads this model itself. A verified copy there is used read-only.
   */
  readonly sharedPath?: readonly string[];
}

const WHISPER_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';
const KOKORO_COMMIT = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const whisperUrl = (file: string) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_COMMIT}/${file}`;
const kokoroUrl = (file: string) =>
  `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_COMMIT}/${file}`;

function whisper(
  id: string,
  label: string,
  description: string,
  file: string,
  sha256: string,
  size: number,
  recommended = false,
): SpeechModelEntry {
  return {
    id,
    kind: 'stt',
    label,
    description,
    recommended,
    license: 'MIT',
    licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
    files: [{ name: file, url: whisperUrl(file), sha256, size }],
    sharedPath: ['.gezel', 'engines', 'whisper-cpp', 'models', id, file],
  };
}

export const KOKORO_MODEL_ID = 'kokoro-82m-v1.0';
export const KOKORO_DEFAULT_VOICE = 'af_heart';
export const KOKORO_SAMPLE_RATE = 24_000;

/** Gezel's curated voices (`KOKORO_DEFAULT_VOICES`), in its order. */
export const KOKORO_VOICES: readonly (SpeechVoiceInfo & { readonly sha256: string })[] = [
  [
    'af_heart',
    'Heart',
    'en-US',
    'female',
    'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  ],
  [
    'af_bella',
    'Bella',
    'en-US',
    'female',
    'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  ],
  [
    'af_nicole',
    'Nicole',
    'en-US',
    'female',
    'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  ],
  [
    'am_adam',
    'Adam',
    'en-US',
    'male',
    '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716',
  ],
  [
    'am_michael',
    'Michael',
    'en-US',
    'male',
    '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  ],
  [
    'bf_emma',
    'Emma',
    'en-GB',
    'female',
    '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  ],
  [
    'bm_george',
    'George',
    'en-GB',
    'male',
    'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  ],
  [
    'bm_lewis',
    'Lewis',
    'en-GB',
    'male',
    'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97',
  ],
].map(([id, label, language, gender, sha256]) => ({
  id: id as string,
  label: label as string,
  language: language as string,
  gender: gender as 'female' | 'male',
  modelId: KOKORO_MODEL_ID,
  sha256: sha256 as string,
}));

/** 510 style vectors × 256 float32 values per voice. */
export const KOKORO_VOICE_BYTES = 522_240;
export const KOKORO_MODEL_FILE = 'onnx/model_quantized.onnx';

export const SPEECH_MODEL_CATALOG: readonly SpeechModelEntry[] = [
  whisper(
    'whisper-tiny.en',
    'Whisper Tiny (English)',
    'Fastest. Good for short notes on slower machines.',
    'ggml-tiny.en.bin',
    '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    77_704_715,
  ),
  whisper(
    'whisper-base.en',
    'Whisper Base (English)',
    'Recommended. Realtime on most laptops.',
    'ggml-base.en.bin',
    'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    147_964_211,
    true,
  ),
  whisper(
    'whisper-small.en',
    'Whisper Small (English)',
    'Most accurate. Slower; better on hard audio.',
    'ggml-small.en.bin',
    'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    487_614_201,
  ),
  {
    id: KOKORO_MODEL_ID,
    kind: 'tts',
    label: 'Kokoro (English voices)',
    description: 'Natural US and UK English narration voices.',
    recommended: true,
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/hexgrad/Kokoro-82M/blob/main/LICENSE',
    files: [
      {
        name: KOKORO_MODEL_FILE,
        url: kokoroUrl(KOKORO_MODEL_FILE),
        sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
        size: 92_361_116,
      },
      ...KOKORO_VOICES.map((voice) => ({
        name: `voices/${voice.id}.bin`,
        url: kokoroUrl(`voices/${voice.id}.bin`),
        sha256: voice.sha256,
        size: KOKORO_VOICE_BYTES,
      })),
    ],
  },
];

export function catalogEntry(id: string): SpeechModelEntry | undefined {
  return SPEECH_MODEL_CATALOG.find((entry) => entry.id === id);
}

export function downloadBytes(entry: SpeechModelEntry): number {
  return entry.files.reduce((sum, file) => sum + file.size, 0);
}

interface Manifest {
  readonly id: string;
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
  readonly installedAt: string;
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
  readonly fetchImpl?: typeof fetch;
  /** Injected by tests; production always uses the pinned catalog. */
  readonly catalog?: readonly SpeechModelEntry[];
}

export class SpeechModelStore {
  private readonly root: string;
  private readonly sharedHome: string | null;
  private readonly fetchImpl: typeof fetch | undefined;
  readonly catalog: readonly SpeechModelEntry[];
  /** Shared files already hashed this session, keyed by path + identity. */
  private readonly sharedVerified = new Map<string, string>();
  private readonly installing = new Map<string, Promise<void>>();

  constructor(options: SpeechModelStoreOptions) {
    this.root = options.root;
    this.sharedHome = options.sharedHome;
    this.fetchImpl = options.fetchImpl;
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

  private sharedFile(entry: SpeechModelEntry): string | null {
    if (!this.sharedHome || !entry.sharedPath || entry.files.length !== 1) return null;
    return path.join(this.sharedHome, ...entry.sharedPath);
  }

  /** Installed in this app's store: the manifest matches the catalog pins and sizes. */
  private async appInstalled(entry: SpeechModelEntry): Promise<boolean> {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(this.modelDir(entry.id), 'manifest.json'), 'utf8'),
      ) as Manifest;
    } catch {
      return false;
    }
    if (manifest.id !== entry.id || manifest.files.length !== entry.files.length) return false;
    for (const file of entry.files) {
      if (!manifest.files.some((m) => m.name === file.name && m.sha256 === file.sha256)) {
        return false;
      }
      try {
        if ((await stat(this.filePath(entry.id, file.name))).size !== file.size) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * A shared copy counts as installed once its full hash matches. The result
   * is cached by size, mtime and inode so a 150 MB file is hashed once per
   * session, not on every status check.
   */
  private async sharedInstalled(entry: SpeechModelEntry, hash: boolean): Promise<boolean> {
    const file = this.sharedFile(entry);
    const pinned = entry.files[0];
    if (!file || !pinned) return false;
    let identity: string;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size !== pinned.size) return false;
      identity = `${info.size}:${info.mtimeMs}:${info.ino}`;
    } catch {
      return false;
    }
    if (this.sharedVerified.get(file) === identity) return true;
    if (!hash) return true;
    const valid = await verifyFile(file, pinned.sha256, pinned.size);
    if (valid) this.sharedVerified.set(file, identity);
    return valid;
  }

  private async sourceOf(entry: SpeechModelEntry): Promise<'app' | 'shared' | null> {
    if (await this.appInstalled(entry)) return 'app';
    // Listing only checks the size; `locate` hashes before anything loads it.
    if (await this.sharedInstalled(entry, false)) return 'shared';
    return null;
  }

  async info(entry: SpeechModelEntry): Promise<SpeechModelInfo> {
    const source = await this.sourceOf(entry);
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      description: entry.description,
      downloadBytes: downloadBytes(entry),
      installed: source !== null,
      source,
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
    if (await this.appInstalled(entry)) {
      return {
        entry,
        source: 'app',
        files: Object.fromEntries(entry.files.map((f) => [f.name, this.filePath(id, f.name)])),
      };
    }
    const shared = this.sharedFile(entry);
    const pinned = entry.files[0];
    if (shared && pinned && (await this.sharedInstalled(entry, true))) {
      return { entry, source: 'shared', files: { [pinned.name]: shared } };
    }
    return null;
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
    const run = this.download(entry, options).finally(() => this.installing.delete(id));
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
    if (await this.appInstalled(entry)) return;
    const total = downloadBytes(entry);
    let completed = 0;
    for (const file of entry.files) {
      const destination = this.filePath(entry.id, file.name);
      await mkdir(path.dirname(destination), { recursive: true });
      if (!(await verifyFile(destination, file.sha256, file.size))) {
        await verifiedDownload({
          url: file.url,
          destination,
          sha256: file.sha256,
          size: file.size,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          onProgress: (received) => options.onProgress?.(completed + received, total),
        });
      }
      completed += file.size;
      options.onProgress?.(completed, total);
    }
    const manifest: Manifest = {
      id: entry.id,
      files: entry.files.map(({ name, sha256 }) => ({ name, sha256 })),
      installedAt: new Date().toISOString(),
    };
    const manifestPath = path.join(this.modelDir(entry.id), 'manifest.json');
    await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(`${manifestPath}.tmp`, manifestPath);
  }

  /** Remove this app's copy. A shared copy belongs to another app and is never touched. */
  async remove(id: string): Promise<void> {
    if (!this.entry(id)) throw new Error(`Unknown speech model: ${id}`);
    await rm(this.modelDir(id), { recursive: true, force: true });
  }
}
