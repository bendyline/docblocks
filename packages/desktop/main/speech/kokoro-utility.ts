/**
 * Entry point of the narration utility process (`utilityProcess.fork`).
 *
 * ONNX Runtime runs here rather than in main so a native fault or a runaway
 * inference costs a respawn, never the app. Main is the only peer: it sends
 * `KokoroRequest`s over `parentPort` and receives `KokoroReply`s.
 */
import * as ort from 'onnxruntime-node';
import { KokoroRuntime, type KokoroRequest, type OrtLike } from './kokoro-runtime.js';

const runtime = new KokoroRuntime(ort as unknown as OrtLike);
const port = process.parentPort;

port.on('message', (event: { data: unknown }) => {
  const request = event.data as KokoroRequest;
  runtime.handle(request, (reply) => port.postMessage(reply));
});
