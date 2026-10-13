/**
 * Transformers.js imports Sharp when its Node build loads, even for text-only
 * pipelines. DocBlocks uses none of its image pipelines, so any call fails.
 */
export const docblocksCompatibilityStub = true;

export default function sharp() {
  const error = new Error('Transformers.js image processing is not bundled with DocBlocks.');
  error.code = 'DOCBLOCKS_TRANSFORMERS_IMAGE_UNSUPPORTED';
  throw error;
}
