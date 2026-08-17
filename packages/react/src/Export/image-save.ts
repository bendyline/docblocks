/**
 * Host persistence for the editor's raster-image exporters.
 *
 * Squisq renders both the cover image and the Dashboard image in the
 * browser and hands the host a finished blob; DocBlocks owns where that
 * blob lands. The two exporters share one contract upstream
 * (`DashboardImageSaveOutput` is an alias of `CoverImageSaveOutput`), so
 * they share one adapter here rather than two identical copies.
 */

/** Host persistence shape required by the editor's image exporters. */
export interface ImageSaveAdapter<TTarget> {
  pickTarget(filename: string, currentTarget?: TTarget | null): Promise<TTarget | null>;
  saveBlob(blob: Blob, filename: string, target?: TTarget | null): Promise<TTarget | null>;
}

export type ImageSaveOutput = (blob: Blob, filename: string) => Promise<boolean | void>;

/**
 * Adapt DocBlocks' two-step host destination flow to Squisq's rendered image
 * output callback. The picker stays host-owned, and cancellation is reported
 * as `false` so the export dialog remains open without showing an error.
 */
export function createImageSaveOutput<TTarget>(
  adapter: ImageSaveAdapter<TTarget>,
): ImageSaveOutput {
  return async (blob, filename) => {
    const target = await adapter.pickTarget(filename, null);
    if (!target) return false;
    return (await adapter.saveBlob(blob, filename, target)) !== null;
  };
}
