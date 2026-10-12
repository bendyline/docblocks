import type { AiModelInfo } from '@bendyline/docblocks/host';
import { selectModel, type ModelDescriptor } from '@bendyline/gezel-app-sdk/browser';

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
