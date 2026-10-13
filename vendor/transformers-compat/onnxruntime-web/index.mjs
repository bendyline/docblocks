/**
 * Transformers.js's Node build inlines the ONNX Runtime Web code it needs and
 * never imports this package; it runs on onnxruntime-node. Loading it is a bug.
 */
const error = new Error(
  'ONNX Runtime Web is not bundled with DocBlocks; Transformers.js runs on onnxruntime-node.',
);
error.code = 'DOCBLOCKS_ONNXRUNTIME_WEB_UNSUPPORTED';
throw error;
