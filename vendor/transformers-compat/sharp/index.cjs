'use strict';

/**
 * CommonJS twin of index.mjs: Transformers.js publishes both Node entry
 * points, so both must find the same no-image guard.
 */
function sharp() {
  const error = new Error('Transformers.js image processing is not bundled with DocBlocks.');
  error.code = 'DOCBLOCKS_TRANSFORMERS_IMAGE_UNSUPPORTED';
  throw error;
}

sharp.docblocksCompatibilityStub = true;

module.exports = sharp;
