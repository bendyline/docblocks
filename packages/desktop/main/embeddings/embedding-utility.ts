/**
 * Entry point of the embedding utility process (`utilityProcess.fork`).
 *
 * ONNX Runtime runs here rather than in main, as narration's does: a native
 * fault or a runaway batch costs a respawn, never the app. The model is
 * Gezel's profile embedder over the bundled, read-only model directory —
 * `localFilesOnly`, so it never downloads, and digest-verified against the
 * profile's pins after loading.
 */
import { availableParallelism } from 'node:os';
import { EmbeddingRuntime, type EmbeddingUtilityRequest } from './embedding-runtime.js';

/** Background indexing shares the machine: at most half the cores, at most four. */
function intraOpThreads(logicalProcessors: number): number {
  return Math.max(1, Math.min(4, Math.floor(logicalProcessors / 2)));
}

const runtime = new EmbeddingRuntime(async (modelDir) => {
  // ESM-only, so a dynamic import from this CJS bundle (kept external).
  const knowledge = await import('@bendyline/gezel-knowledge');
  const embedder = await knowledge.createProfileEmbedder(knowledge.BGE_SMALL_EN_V15_1, {
    cacheDir: modelDir,
    localFilesOnly: true,
    sessionOptions: { intraOpNumThreads: intraOpThreads(availableParallelism()) },
  });
  return {
    embedPassages: (texts) => embedder.embed(texts),
    embedQuery: (text) => embedder.embedQuery(text),
  };
});

const port = process.parentPort;
port.on('message', (event: { data: unknown }) => {
  runtime.handle(event.data as EmbeddingUtilityRequest, (reply) => port.postMessage(reply));
});
