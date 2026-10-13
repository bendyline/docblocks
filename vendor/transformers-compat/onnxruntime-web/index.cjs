'use strict';

/** CommonJS twin of index.mjs. */
const error = new Error(
  'ONNX Runtime Web is not bundled with DocBlocks; Transformers.js runs on onnxruntime-node.',
);
error.code = 'DOCBLOCKS_ONNXRUNTIME_WEB_UNSUPPORTED';
throw error;
