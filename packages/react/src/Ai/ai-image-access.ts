import { useEffect, useState } from 'react';
import type { AiImageAccess, AiImageProgress, AiImagesAPI } from '@bendyline/docblocks/host';

/**
 * Whether image generation can be offered, kept current by the host: it
 * pushes a new state when AI connects or disconnects and while an approval
 * waits. Null until the first answer.
 */
export function useImageAccess(images: AiImagesAPI | undefined): AiImageAccess | null {
  const [access, setAccess] = useState<AiImageAccess | null>(null);
  useEffect(() => {
    if (!images) {
      setAccess(null);
      return;
    }
    let live = true;
    const unsubscribe = images.onAccess((next) => {
      if (live) setAccess(next);
    });
    images
      .access()
      .then((next) => {
        if (live) setAccess(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [images]);
  return access;
}

/** One sentence for a state in which images cannot be generated, or null when they can. */
export function imageAccessSentence(access: AiImageAccess | null): string | null {
  if (!access) return 'Checking image generation…';
  switch (access.kind) {
    case 'ready':
      return null;
    case 'needs-approval':
      return 'Allow DocBlocks to generate images with Gezel.';
    case 'awaiting-approval':
      return 'Approve DocBlocks in Gezel to generate images.';
    case 'provider-outdated':
      return 'This version of Gezel cannot generate images. Update Gezel, then try again.';
    case 'unavailable':
      return access.message;
  }
}

/** What a render is doing, in words. */
export function imageProgressText(progress: AiImageProgress | null, modelLabel: string): string {
  if (!progress) return 'Starting…';
  switch (progress.phase) {
    case 'queued':
      return 'Waiting for another image to finish…';
    case 'loading-model':
      return progress.totalSteps > 0
        ? `Loading ${modelLabel}…`
        : `Loading ${modelLabel}… The first image after starting can take a while.`;
    case 'sampling': {
      const step = `Step ${String(progress.step)} of ${String(progress.totalSteps)}`;
      if (progress.secondsPerStep === null || progress.step >= progress.totalSteps) return step;
      const left = Math.ceil((progress.totalSteps - progress.step) * progress.secondsPerStep);
      return left >= 2 ? `${step} · about ${String(left)} s left` : step;
    }
    case 'decoding':
      return 'Finishing the image…';
  }
}

/** 0–1 within the current phase, or null when the phase reports no measure. */
export function imageProgressFraction(progress: AiImageProgress | null): number | null {
  if (!progress || progress.totalSteps <= 0) return null;
  return Math.min(1, progress.step / progress.totalSteps);
}
