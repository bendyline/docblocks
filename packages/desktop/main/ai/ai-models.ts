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
import type { AiModelDownloadInfo, AiModelInfo } from '@bendyline/docblocks/host';

/** The fields DocBlocks reads from one provider listing entry. */
export interface ProviderModelEntry {
  readonly id: string;
  readonly owned_by?: string;
  readonly context_window?: number;
  readonly name?: string;
  readonly role?: string;
  readonly is_fallback?: boolean;
  readonly availability?: 'available' | 'unavailable' | 'download-required' | 'downloading';
  readonly unavailable_reason?: string;
  readonly locality?: 'on-device' | 'network' | 'unknown';
  readonly download_bytes?: number;
}

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
  const name = entry.name?.trim();
  if (name && name !== entry.id) return name;
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
    if (entry.availability === 'download-required' || entry.availability === 'downloading') {
      continue;
    }
    if (!isBoundedString(entry.id, HOST_WIRE_LIMITS.identifierCharacters, 1)) continue;
    if (seen.has(entry.id)) continue;
    const label = boundLabel(labelFor(entry));
    if (!label) continue;
    seen.add(entry.id);
    accepted.push({ entry, label });
  }

  const fallbackIndex = accepted.findIndex(({ entry }) => entry.is_fallback === true);
  const firstReady = accepted.findIndex(({ entry }) => entry.availability !== 'unavailable');
  const defaultIndex = fallbackIndex >= 0 ? fallbackIndex : firstReady;
  return accepted.map(({ entry, label }, index) => {
    return {
      id: entry.id,
      label,
      // Locality is an SDK capability, never a guess from a provider name.
      local: entry.locality === 'on-device',
      contextWindow: contextWindowOf(entry),
      isDefault: index === defaultIndex,
      ...(entry.availability === 'unavailable'
        ? {
            availability: 'unavailable' as const,
            ...(entry.unavailable_reason
              ? { unavailableReason: boundLabel(entry.unavailable_reason) }
              : {}),
          }
        : {}),
    };
  });
}

/** Keep the bounded, explicitly downloadable part of a provider listing. */
export function toAiModelDownloadList(
  entries: readonly ProviderModelEntry[],
): AiModelDownloadInfo[] {
  const seen = new Set<string>();
  const models: AiModelDownloadInfo[] = [];
  for (const entry of entries) {
    if (models.length >= AI_WIRE_LIMITS.modelEntries) break;
    if (entry.availability !== 'download-required' && entry.availability !== 'downloading') {
      continue;
    }
    if (!isBoundedString(entry.id, HOST_WIRE_LIMITS.identifierCharacters, 1)) continue;
    if (seen.has(entry.id)) continue;
    const label = boundLabel(labelFor(entry));
    if (!label) continue;
    const bytes = entry.download_bytes;
    seen.add(entry.id);
    models.push({
      id: entry.id,
      label,
      contextWindow: contextWindowOf(entry),
      downloadBytes:
        typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null,
      state: entry.availability,
    });
  }
  return models;
}

/** The user's preferred model when the provider still offers it, else the default. */
export function selectModel(
  models: readonly AiModelInfo[],
  preferred: string | null,
): AiModelInfo | null {
  const ready = models.filter(
    (model) =>
      model.availability !== 'unavailable' &&
      model.availability !== 'download-required' &&
      model.availability !== 'downloading',
  );
  if (preferred) {
    const match = ready.find((model) => model.id === preferred);
    if (match) return match;
  }
  return ready.find((model) => model.isDefault) ?? ready[0] ?? null;
}
