import type { FfmpegWasmLoadConfig } from '@bendyline/squisq-video';

const baseUrl = import.meta.env.BASE_URL;

/** Same-origin ffmpeg.wasm assets packaged with the Electron renderer. */
export const DESKTOP_FFMPEG_WASM_CONFIG: FfmpegWasmLoadConfig = Object.freeze({
  coreURL: `${baseUrl}ffmpeg-core/ffmpeg-core.js`,
  wasmURL: `${baseUrl}ffmpeg-core/ffmpeg-core.wasm`,
});
