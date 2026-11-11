import type { AiModelFit, AiModelInfo } from '@bendyline/docblocks/host';
import { selectModel, type ModelDescriptor } from '@bendyline/gezel-app-sdk/browser';

/**
 * Gezel's rating of a catalog download against this device's memory, for the
 * label Settings shows beside it; null when Gezel sent none. A `too-big` model
 * is never offered (Gezel lists it as unavailable), so it has no label here.
 */
export function downloadFit(model: Pick<ModelDescriptor, 'fit'>): AiModelFit | null {
  const fit = model.fit;
  return fit && fit.tier !== 'too-big'
    ? { tier: fit.tier, label: fit.label, detail: fit.detail }
    : null;
}

/** Gezel owns model identities, preparation, budgets and readiness on every host. */
export function modelChoices(
  models: readonly ModelDescriptor[],
  preferred: string | null,
): AiModelInfo[] {
  const selected = selectModel(models, {
    preferredId: preferred,
    fallback: preferred ? 'none' : 'prefer-system',
  });
  return models
    .filter((model) => model.preparation !== 'app-download' || model.availability === 'available')
    .map((model) => ({
      id: model.id,
      label: model.name,
      local: model.locality === 'on-device',
      contextWindow: model.context_window ?? null,
      isDefault: model.id === selected?.id,
      availability: model.availability,
      ...(model.unavailable_reason ? { unavailableReason: model.unavailable_reason } : {}),
    }));
}
