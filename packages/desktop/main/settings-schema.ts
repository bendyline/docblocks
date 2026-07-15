import path from 'node:path';
import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';

export interface PersistedWorkspace {
  id: string;
  name: string;
  rootPath: string;
  /** Base64 macOS security-scoped bookmark. */
  bookmark?: string;
}

export interface PersistedExportTargetAccess {
  path: string;
  bookmark?: string;
  confirmedByPicker?: true;
}

export interface PersistedExportTarget {
  last?: PersistedExportTargetAccess;
  byExtension?: Record<string, PersistedExportTargetAccess>;
}

export interface Settings {
  defaultWorkspaceRoot?: string;
  workspaces: PersistedWorkspace[];
  iCloudPromptShown?: boolean;
  lastCloneParentDir?: string;
  exportTargets?: Record<string, PersistedExportTarget>;
}

export const SETTINGS_MAX_BYTES = 4 * 1024 * 1024;

const SETTINGS_KEYS = [
  'defaultWorkspaceRoot',
  'workspaces',
  'iCloudPromptShown',
  'lastCloneParentDir',
  'exportTargets',
] as const;

/** Parse the complete persisted settings boundary; unknown fields are rejected. */
export function parseSettings(value: unknown): Settings {
  const record = exactRecord(value, SETTINGS_KEYS, 'settings');
  if (!Array.isArray(record.workspaces)) invalid('workspaces must be an array');
  if (record.workspaces.length > HOST_WIRE_LIMITS.arrayEntries) {
    invalid('workspaces exceeds the entry limit');
  }

  const workspaces = record.workspaces.map(parseWorkspace);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  if (workspaceIds.size !== workspaces.length) invalid('workspace IDs must be unique');

  const parsed: Settings = { workspaces };
  if (record.defaultWorkspaceRoot !== undefined) {
    parsed.defaultWorkspaceRoot = absolutePath(record.defaultWorkspaceRoot, 'defaultWorkspaceRoot');
  }
  if (record.iCloudPromptShown !== undefined) {
    if (typeof record.iCloudPromptShown !== 'boolean') {
      invalid('iCloudPromptShown must be a boolean');
    }
    parsed.iCloudPromptShown = record.iCloudPromptShown;
  }
  if (record.lastCloneParentDir !== undefined) {
    parsed.lastCloneParentDir = absolutePath(record.lastCloneParentDir, 'lastCloneParentDir');
  }
  if (record.exportTargets !== undefined) {
    parsed.exportTargets = parseExportTargets(record.exportTargets);
  }
  return parsed;
}

function parseWorkspace(value: unknown, index: number): PersistedWorkspace {
  const record = exactRecord(value, ['id', 'name', 'rootPath', 'bookmark'], `workspaces[${index}]`);
  const workspace: PersistedWorkspace = {
    id: boundedString(record.id, HOST_WIRE_LIMITS.identifierCharacters, `workspaces[${index}].id`),
    name: boundedString(record.name, HOST_WIRE_LIMITS.labelCharacters, `workspaces[${index}].name`),
    rootPath: absolutePath(record.rootPath, `workspaces[${index}].rootPath`),
  };
  if (record.bookmark !== undefined) {
    workspace.bookmark = boundedString(
      record.bookmark,
      SETTINGS_MAX_BYTES,
      `workspaces[${index}].bookmark`,
    );
  }
  return workspace;
}

function parseExportTargets(value: unknown): Record<string, PersistedExportTarget> {
  const record = plainRecord(value, 'exportTargets');
  const entries = Object.entries(record);
  if (entries.length > HOST_WIRE_LIMITS.arrayEntries)
    invalid('exportTargets exceeds the entry limit');
  const targets: Record<string, PersistedExportTarget> = {};
  for (const [key, target] of entries) {
    if (!isBoundedString(key, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
      invalid('exportTargets contains an invalid key');
    }
    targets[key] = parseExportTarget(target, `exportTargets.${key}`);
  }
  return targets;
}

function parseExportTarget(value: unknown, label: string): PersistedExportTarget {
  const record = exactRecord(value, ['last', 'byExtension'], label);
  const target: PersistedExportTarget = {};
  if (record.last !== undefined) target.last = parseExportAccess(record.last, `${label}.last`);
  if (record.byExtension !== undefined) {
    const extensions = plainRecord(record.byExtension, `${label}.byExtension`);
    const entries = Object.entries(extensions);
    if (entries.length > HOST_WIRE_LIMITS.arrayEntries) {
      invalid(`${label}.byExtension exceeds the entry limit`);
    }
    target.byExtension = {};
    for (const [extension, access] of entries) {
      if (!/^[a-z0-9][a-z0-9._+-]{0,31}$/u.test(extension)) {
        invalid(`${label}.byExtension contains an invalid extension`);
      }
      target.byExtension[extension] = parseExportAccess(
        access,
        `${label}.byExtension.${extension}`,
      );
    }
  }
  return target;
}

function parseExportAccess(value: unknown, label: string): PersistedExportTargetAccess {
  const record = exactRecord(value, ['path', 'bookmark', 'confirmedByPicker'], label);
  const access: PersistedExportTargetAccess = { path: absolutePath(record.path, `${label}.path`) };
  if (record.bookmark !== undefined) {
    access.bookmark = boundedString(record.bookmark, SETTINGS_MAX_BYTES, `${label}.bookmark`);
  }
  if (record.confirmedByPicker !== undefined) {
    if (record.confirmedByPicker !== true) invalid(`${label}.confirmedByPicker must be true`);
    access.confirmedByPicker = true;
  }
  return access;
}

function absolutePath(value: unknown, label: string): string {
  const parsed = boundedString(value, HOST_WIRE_LIMITS.pathCharacters, label);
  if (!path.isAbsolute(parsed)) invalid(`${label} must be absolute`);
  return parsed;
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (!isBoundedString(value, maximum, 1)) invalid(`${label} must be a bounded non-empty string`);
  return value;
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = plainRecord(value, label);
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknownKey) invalid(`${label} contains unknown field ${unknownKey}`);
  return record;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalid(message: string): never {
  throw new Error(`Invalid desktop settings: ${message}`);
}
