/**
 * IPC for `DocBlocksHostEmbeddingsAPI`: the bundled embedding model, run in
 * its own utility process, for semantic workspace search.
 *
 * Every handler is owner- and origin-checked and parses its arguments with
 * the shared embeddings wire policy. The model directory is main-owned —
 * the packaged resources, or a source build's staged copy — and never comes
 * from the renderer.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import {
  parseEmbeddingsRequest,
  type EmbeddingsStatus,
  type EmbeddingsTokenizer,
} from '@bendyline/docblocks/host';
import manifest from '../embedding-model.json';
import { registerTrustedIpcHandler } from './ipc-authority.js';
import { EmbeddingEngine, type EmbeddingChannel } from './embeddings/embedding-engine.js';
import type { EmbeddingUtilityReply } from './embeddings/embedding-runtime.js';
import { onnxRuntimeBinding } from './speech/kokoro-frontend.js';

export interface EmbeddingModelManifest {
  readonly profileId: string;
  readonly dimensions: number;
  readonly repo: string;
  readonly revision: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    /** Staged at `<repo>/<path>` rather than `<repo>/<revision>/<path>`. */
    readonly unversioned?: boolean;
  }>;
}

export const EMBEDDING_MODEL: EmbeddingModelManifest = manifest;

/** Where a pinned file sits in the transformers.js cache layout. */
export function embeddingModelFile(
  modelDir: string,
  file: string,
  model: EmbeddingModelManifest = EMBEDDING_MODEL,
  unversioned = false,
): string {
  const revision = unversioned ? [] : [model.revision];
  return path.join(modelDir, ...model.repo.split('/'), ...revision, ...file.split('/'));
}

/**
 * The bundled model's directory: packaged resources, or a source build's
 * `dist/embedding-model` from `npm run stage:embedding-model`.
 */
export function embeddingModelDir(options: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
  readonly env: NodeJS.ProcessEnv;
}): string {
  if (!options.isPackaged) {
    const override = options.env.DOCBLOCKS_EMBEDDING_MODEL_DIR?.trim();
    if (override) return override;
    return path.join(options.appPath, 'dist', 'embedding-model');
  }
  return path.join(options.resourcesPath, 'embedding-model');
}

/**
 * Why the model cannot run here, from files alone (sizes, not digests: the
 * embedder verifies digests after loading), or null when it can.
 */
export function embeddingModelProblem(
  modelDir: string,
  model: EmbeddingModelManifest = EMBEDDING_MODEL,
): string | null {
  for (const file of model.files) {
    const target = embeddingModelFile(modelDir, file.path, model, file.unversioned === true);
    try {
      if (statSync(target).size !== file.bytes) {
        return 'The semantic search model in this build is damaged.';
      }
    } catch {
      return app.isPackaged
        ? 'Semantic search is not included in this build of DocBlocks.'
        : 'Semantic search needs its model staged. Run `npm run stage:embedding-model` in the DocBlocks repository, then restart DocBlocks.';
    }
  }
  return null;
}

export interface EmbeddingService {
  readonly available: boolean;
  status(): EmbeddingsStatus;
  embed(kind: 'passage' | 'query', texts: readonly string[]): Promise<Float32Array[]>;
  tokenizer(): Promise<EmbeddingsTokenizer | null>;
  dispose(): void;
}

function forkUtility(entry: string): EmbeddingChannel {
  const child = utilityProcess.fork(entry, [], {
    serviceName: 'DocBlocks Semantic Search',
    stdio: 'ignore',
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on('message', (reply: EmbeddingUtilityReply) => listener(reply)),
    onExit: (listener) => child.on('exit', listener),
    kill: () => {
      child.kill();
    },
  };
}

function unavailable(reason: string): EmbeddingService {
  return {
    available: false,
    status: () => ({
      profileId: EMBEDDING_MODEL.profileId,
      dimensions: EMBEDDING_MODEL.dimensions,
      state: 'unavailable',
      reason,
      download: null,
    }),
    embed: () => Promise.reject(new Error(reason)),
    tokenizer: () => Promise.resolve(null),
    dispose: () => undefined,
  };
}

/**
 * Decide whether semantic search can run here from files alone — never by
 * loading ONNX Runtime in main, which would undo the process isolation.
 */
export function createEmbeddingService(env: NodeJS.ProcessEnv = process.env): EmbeddingService {
  const modelDir = embeddingModelDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    env,
  });
  // Development and e2e only: a stand-in utility with deterministic vectors,
  // so the real utilityProcess plumbing runs without the model.
  const fake = (app.isPackaged ? undefined : env.DOCBLOCKS_EMBEDDINGS_ENTRY?.trim()) || undefined;
  if (!fake) {
    if (process.platform === 'darwin') {
      // The prebuilt ONNX Runtime declares macOS 14 as its minimum.
      const major = Number(process.getSystemVersion().split('.')[0]);
      if (Number.isFinite(major) && major < 14) {
        return unavailable('Semantic search needs macOS 14 or later.');
      }
    }
    try {
      if (!existsSync(onnxRuntimeBinding(require.resolve('onnxruntime-node/package.json')))) {
        return unavailable('Semantic search is not available on this computer.');
      }
    } catch {
      return unavailable('Semantic search is not included in this build of DocBlocks.');
    }
  }
  // The stand-in needs no model files; its tokenizer is read when present.
  const problem = fake ? null : embeddingModelProblem(modelDir);
  if (problem) return unavailable(problem);

  const entry = fake ?? path.join(__dirname, 'embedding-utility.cjs');
  const engine = new EmbeddingEngine({ modelDir, fork: () => forkUtility(entry) });
  let tokenizer: Promise<EmbeddingsTokenizer | null> | null = null;
  return {
    available: true,
    status: () => ({
      profileId: EMBEDDING_MODEL.profileId,
      dimensions: EMBEDDING_MODEL.dimensions,
      state: 'ready',
      reason: null,
      download: null,
    }),
    embed: (kind, texts) => engine.embed(kind, texts),
    tokenizer() {
      tokenizer ??= Promise.all([
        readFile(embeddingModelFile(modelDir, 'tokenizer.json'), 'utf8'),
        readFile(embeddingModelFile(modelDir, 'tokenizer_config.json'), 'utf8'),
      ]).then(
        ([definition, config]) => ({ definition, config }),
        () => {
          tokenizer = null;
          return null;
        },
      );
      return tokenizer;
    },
    dispose: () => engine.dispose(),
  };
}

export function registerEmbeddingsIpc(service: EmbeddingService): void {
  registerTrustedIpcHandler('embeddings:status', 0, () => service.status());
  if (!service.available) return;
  registerTrustedIpcHandler('embeddings:embed', 1, (_event, value: unknown) => {
    const request = parseEmbeddingsRequest(value);
    if (!request) throw new Error('Invalid embedding request');
    return service.embed(request.kind, request.texts);
  });
  registerTrustedIpcHandler('embeddings:tokenizer', 0, () => service.tokenizer());
}
