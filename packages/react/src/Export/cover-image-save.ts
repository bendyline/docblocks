/**
 * Cover-image host persistence. The flow is identical to the Dashboard
 * image exporter's, so both are the one adapter in `image-save.ts`; this
 * module keeps the cover-specific names the editor surfaces read against.
 */
export type {
  ImageSaveAdapter as CoverImageSaveAdapter,
  ImageSaveOutput as CoverImageSaveOutput,
} from './image-save.js';
export { createImageSaveOutput as createCoverImageSaveOutput } from './image-save.js';
