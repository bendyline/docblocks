import type { WorkspaceDescriptor } from './types.js';

const MAX_IDENTIFIER_CHARACTERS = 256;
const MAX_LABEL_CHARACTERS = 1_024;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_WORKSPACES = 10_000;

/** Parse the complete persisted workspace list before it reaches startup code. */
export function parsePersistedWorkspaceList(value: unknown): WorkspaceDescriptor[] {
  if (!Array.isArray(value)) throw new Error('Persisted workspaces must be an array.');
  if (value.length > MAX_WORKSPACES) throw new Error('Persisted workspace list is too large.');
  const parsed = value.map(parsePersistedWorkspace);
  if (new Set(parsed.map((workspace) => workspace.id)).size !== parsed.length) {
    throw new Error('Persisted workspace IDs must be unique.');
  }
  return parsed;
}

function parsePersistedWorkspace(value: unknown, index: number): WorkspaceDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Persisted workspace ${index} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = ['id', 'name', 'type', 'lastOpened', 'rootPath', 'versioningOverride'];
  const unknownKey = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknownKey) throw new Error(`Persisted workspace ${index} has unknown field ${unknownKey}.`);

  const id = boundedString(record.id, MAX_IDENTIFIER_CHARACTERS, `workspace ${index} id`);
  const name = boundedString(record.name, MAX_LABEL_CHARACTERS, `workspace ${index} name`);
  if (
    record.type !== 'indexeddb' &&
    record.type !== 'native' &&
    record.type !== 'electron-native'
  ) {
    throw new Error(`Persisted workspace ${index} has an invalid provider type.`);
  }
  const lastOpened = boundedString(
    record.lastOpened,
    MAX_IDENTIFIER_CHARACTERS,
    `workspace ${index} lastOpened`,
  );
  if (
    !Number.isFinite(Date.parse(lastOpened)) ||
    new Date(lastOpened).toISOString() !== lastOpened
  ) {
    throw new Error(`Persisted workspace ${index} has an invalid lastOpened timestamp.`);
  }

  const descriptor: WorkspaceDescriptor = { id, name, type: record.type, lastOpened };
  if (record.rootPath !== undefined) {
    descriptor.rootPath = boundedString(
      record.rootPath,
      MAX_PATH_CHARACTERS,
      `workspace ${index} rootPath`,
    );
  }
  if (record.type === 'electron-native' && descriptor.rootPath === undefined) {
    throw new Error(`Persisted Electron workspace ${index} is missing rootPath.`);
  }
  if (record.type !== 'electron-native' && descriptor.rootPath !== undefined) {
    throw new Error(`Persisted workspace ${index} must not contain rootPath.`);
  }
  if (record.versioningOverride !== undefined) {
    if (
      record.versioningOverride !== 'inherit' &&
      record.versioningOverride !== 'on' &&
      record.versioningOverride !== 'off'
    ) {
      throw new Error(`Persisted workspace ${index} has an invalid versioning override.`);
    }
    descriptor.versioningOverride = record.versioningOverride;
  }
  return descriptor;
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new Error(`Persisted ${label} must be a bounded non-empty string.`);
  }
  return value;
}
