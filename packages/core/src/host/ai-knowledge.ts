import type { AiResult } from './ai.js';
import { HOST_WIRE_LIMITS, isBoundedString } from './wire-policy.js';

/** Provider-neutral catalog management. IDs never authorize filesystem access. */
export interface AiKnowledgeCatalog {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly installedVersion: string | null;
  readonly enabled: boolean;
  readonly updateAvailable: boolean;
  readonly downloadBytes: number | null;
  readonly documents: number | null;
  readonly state: 'available' | 'installed' | 'downloading' | 'error';
  readonly percent: number | null;
  readonly message: string | null;
}

export interface AiKnowledgeState {
  readonly catalogs: readonly AiKnowledgeCatalog[];
  /**
   * A one-time model download that improves knowledge results, sized for the
   * offer. Null when not offered: installed, unavailable, or no enabled
   * catalog would use it. The provider decides; people only see the offer.
   */
  readonly improvement: { readonly downloadBytes: number; readonly downloading: boolean } | null;
}

export type AiKnowledgeAction =
  | {
      readonly action: 'install' | 'remove' | 'enable' | 'disable' | 'cancel';
      readonly catalogId: string;
    }
  /** Start the `improvement` download. */
  | { readonly action: 'improve' };

export interface AiKnowledgeAPI {
  state(): Promise<AiResult<AiKnowledgeState>>;
  update(action: AiKnowledgeAction): Promise<AiResult<null>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
const label = (value: unknown): value is string =>
  isBoundedString(value, HOST_WIRE_LIMITS.labelCharacters, 1);
const message = (value: unknown): value is string | null =>
  value === null || isBoundedString(value, HOST_WIRE_LIMITS.messageCharacters);
const count = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

export function parseAiKnowledgeAction(value: unknown): AiKnowledgeAction | null {
  if (!record(value)) return null;
  if (value.action === 'improve' && exact(value, ['action'])) return { action: value.action };
  if (!exact(value, ['action', 'catalogId']) || !label(value.catalogId)) return null;
  switch (value.action) {
    case 'install':
    case 'remove':
    case 'enable':
    case 'disable':
    case 'cancel':
      return { action: value.action, catalogId: value.catalogId };
    default:
      return null;
  }
}

export function parseAiKnowledgeState(value: unknown): AiKnowledgeState | null {
  if (
    !record(value) ||
    !exact(value, ['catalogs', 'improvement']) ||
    !Array.isArray(value.catalogs) ||
    value.catalogs.length > 512
  )
    return null;
  let improvement: AiKnowledgeState['improvement'] = null;
  if (value.improvement !== null) {
    const raw = value.improvement;
    if (
      !record(raw) ||
      !exact(raw, ['downloadBytes', 'downloading']) ||
      typeof raw.downloadBytes !== 'number' ||
      !count(raw.downloadBytes) ||
      typeof raw.downloading !== 'boolean'
    )
      return null;
    improvement = { downloadBytes: raw.downloadBytes, downloading: raw.downloading };
  }
  const catalogs: AiKnowledgeCatalog[] = [];
  const ids = new Set<string>();
  for (const raw of value.catalogs) {
    if (
      !record(raw) ||
      !exact(raw, [
        'id',
        'name',
        'description',
        'version',
        'installedVersion',
        'enabled',
        'updateAvailable',
        'downloadBytes',
        'documents',
        'state',
        'percent',
        'message',
      ])
    )
      return null;
    if (
      !label(raw.id) ||
      ids.has(raw.id) ||
      !label(raw.name) ||
      !isBoundedString(raw.description, HOST_WIRE_LIMITS.messageCharacters) ||
      !label(raw.version) ||
      !(raw.installedVersion === null || label(raw.installedVersion)) ||
      typeof raw.enabled !== 'boolean' ||
      typeof raw.updateAvailable !== 'boolean' ||
      !count(raw.downloadBytes) ||
      !count(raw.documents) ||
      !message(raw.message)
    )
      return null;
    if (
      raw.state !== 'available' &&
      raw.state !== 'installed' &&
      raw.state !== 'downloading' &&
      raw.state !== 'error'
    )
      return null;
    if (
      raw.percent !== null &&
      !(
        typeof raw.percent === 'number' &&
        Number.isFinite(raw.percent) &&
        raw.percent >= 0 &&
        raw.percent <= 100
      )
    )
      return null;
    ids.add(raw.id);
    catalogs.push({
      id: raw.id,
      name: raw.name,
      description: raw.description,
      version: raw.version,
      installedVersion: raw.installedVersion,
      enabled: raw.enabled,
      updateAvailable: raw.updateAvailable,
      downloadBytes: raw.downloadBytes,
      documents: raw.documents,
      state: raw.state,
      percent: raw.percent,
      message: raw.message,
    });
  }
  return { catalogs, improvement };
}
