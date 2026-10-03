/**
 * Host persistence for Squisq's rendered-output exporters.
 *
 * Squisq renders the cover image, the Dashboard image, and exported video in
 * the browser and hands the host a finished blob; DocBlocks owns where that
 * blob lands. The exporters share one save-output contract upstream
 * (`DashboardImageSaveOutput` is an alias of `CoverImageSaveOutput`, and the
 * video dialog's `saveOutput` has the same shape), so they share one adapter
 * here rather than identical copies.
 */

import { hostErrorDetail } from './host-error.js';

/** Host persistence shape required by the editor's rendered-output exporters. */
export interface ImageSaveAdapter<TTarget> {
  pickTarget(filename: string, currentTarget?: TTarget | null): Promise<TTarget | null>;
  saveBlob(blob: Blob, filename: string, target?: TTarget | null): Promise<TTarget | null>;
}

export type ImageSaveOutput = (blob: Blob, filename: string) => Promise<boolean | void>;

/**
 * Adapt DocBlocks' two-step host destination flow to Squisq's rendered output
 * callback. The picker stays host-owned, and cancellation is reported as
 * `false` so the export dialog remains open without showing an error. Squisq
 * shows a failure's message verbatim, so it arrives without IPC internals.
 */
export function createImageSaveOutput<TTarget>(
  adapter: ImageSaveAdapter<TTarget>,
): ImageSaveOutput {
  return async (blob, filename) => {
    try {
      const target = await adapter.pickTarget(filename, null);
      if (!target) return false;
      return (await adapter.saveBlob(blob, filename, target)) !== null;
    } catch (caught: unknown) {
      throw new Error(hostErrorDetail(caught) || `Couldn't save "${filename}".`);
    }
  };
}
