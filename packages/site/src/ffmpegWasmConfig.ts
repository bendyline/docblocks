import type { FfmpegWasmLoadConfig } from '@bendyline/squisq-video';

const baseUrl = import.meta.env.BASE_URL;

/** Same-origin ffmpeg.wasm assets published by the site's Vite build. */
export const SITE_FFMPEG_WASM_CONFIG: FfmpegWasmLoadConfig = Object.freeze({
  coreURL: `${baseUrl}ffmpeg-core/ffmpeg-core.js`,
  wasmURL: `${baseUrl}ffmpeg-core/ffmpeg-core.wasm`,
});
