/**
 * Translate the provider's model listing into `AiModelInfo`.
 *
 * Gezel's `/v1/models` lists two kinds of entry: the user's gezels (personas,
 * `owned_by: 'gezel'`), led by the one Gezel falls back to for an unknown
 * model, and then raw provider models as `<provider>:<model>`. DocBlocks
 * offers both; the fallback gezel is the default because it is the choice the
 * user already made in Gezel for connected apps.
 */

import { AI_WIRE_LIMITS, HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import type { AiModelInfo } from '@bendyline/docblocks/host';

/** The fields DocBlocks reads from one provider listing entry. */
export interface ProviderModelEntry {
  readonly id: string;
  readonly owned_by?: string;
  readonly context_window?: number;
  readonly name?: string;
  readonly role?: string;
  readonly is_fallback?: boolean;
}

/**
 * Providers whose inference runs on this device. `local` is a privacy claim
 * the UI may repeat to the user, so it is made only where it is known to be
 * true: a gezel's backing model is not visible through this listing, and a
 * gezel is therefore never claimed as local.
 */
const ON_DEVICE_PROVIDERS: ReadonlySet<string> = new Set(['llama-cpp', 'mlx', 'ollama', 'ds4']);

function boundLabel(label: string): string {
  const clean = label.replaceAll('\0', '').trim();
  const limit = HOST_WIRE_LIMITS.labelCharacters;
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function providerOf(entry: ProviderModelEntry): string | null {
  if (entry.owned_by === 'gezel') return null;
  const separator = entry.id.indexOf(':');
  return separator > 0 ? entry.id.slice(0, separator) : (entry.owned_by ?? null);
}

function labelFor(entry: ProviderModelEntry): string {
  if (entry.owned_by === 'gezel') {
    const name = entry.name?.trim();
    if (!name) return entry.id;
    const role = entry.role?.trim();
    return role && role.toLowerCase() !== name.toLowerCase() ? `${name} (${role})` : name;
  }
  const provider = providerOf(entry);
  const model = provider ? entry.id.slice(provider.length + 1) : entry.id;
  return provider && model ? `${model} · ${provider}` : entry.id;
}

function contextWindowOf(entry: ProviderModelEntry): number | null {
  const value = entry.context_window;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= AI_WIRE_LIMITS.contextWindowCeiling
    ? value
    : null;
}

/**
 * Keep every entry that can cross the wire, in provider order, deduplicated
 * and capped. Exactly one entry is marked default when the list is non-empty:
 * the provider's fallback, or the first entry when it names none.
 */
export function toAiModelList(entries: readonly ProviderModelEntry[]): AiModelInfo[] {
  const seen = new Set<string>();
  const accepted: Array<{ entry: ProviderModelEntry; label: string }> = [];
  for (const entry of entries) {
    if (accepted.length >= AI_WIRE_LIMITS.modelEntries) break;
    if (!isBoundedString(entry.id, HOST_WIRE_LIMITS.identifierCharacters, 1)) continue;
    if (seen.has(entry.id)) continue;
    const label = boundLabel(labelFor(entry));
    if (!label) continue;
    seen.add(entry.id);
    accepted.push({ entry, label });
  }

  const fallbackIndex = accepted.findIndex(({ entry }) => entry.is_fallback === true);
  const defaultIndex = fallbackIndex >= 0 ? fallbackIndex : 0;
  return accepted.map(({ entry, label }, index) => {
    const provider = providerOf(entry);
    return {
      id: entry.id,
      label,
      local: provider !== null && ON_DEVICE_PROVIDERS.has(provider),
      contextWindow: contextWindowOf(entry),
      isDefault: index === defaultIndex,
    };
  });
}

/** The user's preferred model when the provider still offers it, else the default. */
export function selectModel(
  models: readonly AiModelInfo[],
  preferred: string | null,
): AiModelInfo | null {
  if (preferred) {
    const match = models.find((model) => model.id === preferred);
    if (match) return match;
  }
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}
