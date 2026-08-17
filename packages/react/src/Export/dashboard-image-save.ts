/**
 * Dashboard-image host persistence.
 *
 * Squisq's Dashboard mode renders the whole document onto one canvas and
 * offers it as a raster export at a range of sizes. It hands the host the
 * finished blob through the same callback shape the cover exporter uses
 * (`DashboardImageSaveOutput` is an alias of `CoverImageSaveOutput`
 * upstream), so this module is naming, not a second implementation.
 */
export type {
  ImageSaveAdapter as DashboardImageSaveAdapter,
  ImageSaveOutput as DashboardImageSaveOutput,
} from './image-save.js';
export { createImageSaveOutput as createDashboardImageSaveOutput } from './image-save.js';
