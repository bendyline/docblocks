import {
  MobileModelInventorySchema,
  MobileModelDownloadsSchema,
  MobileProviderListSchema,
  MobileModelSourceIdentitySchema,
  type MobileModelInventory,
  type MobileProvider,
} from '@bendyline/gezel/mobile-providers';
import type { GezelRuntimePlugin } from '@bendyline/gezel-capacitor';
import type { AiModelInfo } from '@bendyline/docblocks/host';
import snapshot from './catalog.json';

/** Catalog identities and hashes come from Gezel's pinned Gilde projection. */
export const catalog = snapshot.models.map((model) => ({
  ...model,
  id: `catalog:${model.source.catalogId}`,
  source: MobileModelSourceIdentitySchema.parse(model.source),
}));

// Native results are wire values even when the plugin's TypeScript declaration says otherwise.
export function field(value: unknown, key: string): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, key)
  )
    throw new Error('The on-device runtime returned an invalid response.');
  return (value as Record<string, unknown>)[key];
}
export async function inventory(runtime: GezelRuntimePlugin) {
  const [providers, models] = await Promise.all([runtime.providers(), runtime.listModels()]);
  return {
    providers: MobileProviderListSchema.parse(field(providers, 'providers')),
    models: MobileModelInventorySchema.parse(models),
  };
}
export async function downloads(runtime: GezelRuntimePlugin) {
  return MobileModelDownloadsSchema.parse(await runtime.listModelDownloads()).downloads;
}
export function providerLabel(provider: MobileProvider): string {
  if (provider.id === 'apple-foundation-models') return 'Apple Foundation Models';
  if (provider.id === 'android-mlkit') return 'Gemini Nano (Android ML Kit)';
  return provider.name;
}
export function modelChoices(
  providers: MobileProvider[],
  inventory: MobileModelInventory,
  preferred: string | null,
): AiModelInfo[] {
  const choices = providers
    .filter((provider) => provider.capabilities.text)
    .flatMap((provider) => {
      const models =
        provider.id === 'llama-cpp'
          ? inventory.models
          : [{ id: provider.id, name: providerLabel(provider) }];
      return models.map((model) => ({
        id: `${provider.id}:${model.id}`,
        label: model.name,
        local: true,
        // The SDK's portable transport currently chooses at most a 4K context.
        contextWindow: Math.min(provider.contextTokens, 4096),
        isDefault: false,
        availability: provider.availability,
        ...(provider.availability === 'available'
          ? {}
          : {
              unavailableReason:
                provider.reason ??
                (provider.availability === 'download-required'
                  ? 'Choose Add model… to download and prepare this model.'
                  : provider.availability === 'downloading'
                    ? 'The system model is downloading. Choose Add model… to continue preparation.'
                    : 'This model is not available on this device.'),
            }),
      }));
    });
  const ready = choices.filter((model) => model.availability === 'available');
  const selected =
    preferred ??
    ready.find((model) => !model.id.startsWith('llama-cpp:'))?.id ??
    (inventory.selectedModelId ? `llama-cpp:${inventory.selectedModelId}` : ready[0]?.id);
  return choices.map((model) => ({
    ...model,
    isDefault: model.availability === 'available' && model.id === selected,
  }));
}
