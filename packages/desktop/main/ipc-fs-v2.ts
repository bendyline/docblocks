import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import {
  parseFileSystemVersion,
  parseWorkspacePath,
  type FileSystemCreateDirectoryOptions,
  type FileSystemMoveOptions,
  type FileSystemRemoveOptions,
  type FileSystemWriteOptions,
  type FileSystemVersion,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  HOST_WIRE_LIMITS,
  isBoundedBytePayload,
  isBoundedString,
  type HostFileSystemV2OpenRequest,
} from '@bendyline/docblocks/host';

import { FileSystemV2IpcService } from './filesystem-v2-ipc-service.js';
import { registerTrustedIpcHandler } from './ipc-authority.js';
import { bindOwnerGrantRevocation } from './owner-revocation.js';
import { getWorkspaceRoots } from './workspace-roots.js';

interface OwnerRecord {
  readonly key: string;
  readonly sender: WebContents;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseIdentifier(value: unknown, label: string): string {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function parsePath(value: unknown): WorkspacePath {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.pathCharacters)) {
    throw new Error('Invalid workspace path');
  }
  return parseWorkspacePath(value);
}

function parseVersion(value: unknown, nullable = false): FileSystemVersion | null | undefined {
  if (value === undefined || (nullable && value === null)) return value;
  if (!isBoundedString(value, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
    throw new Error('Invalid filesystem version');
  }
  return parseFileSystemVersion(value);
}

function parseWriteOptions(value: unknown): FileSystemWriteOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['mode', 'createParents', 'expectedVersion'])) {
    throw new Error('Invalid filesystem write options');
  }
  if (value.mode !== undefined && !['upsert', 'create', 'replace'].includes(String(value.mode))) {
    throw new Error('Invalid filesystem write mode');
  }
  if (value.createParents !== undefined && typeof value.createParents !== 'boolean') {
    throw new Error('Invalid filesystem createParents option');
  }
  const expectedVersion = parseVersion(value.expectedVersion, true);
  return {
    ...(typeof value.mode === 'string'
      ? { mode: value.mode as 'upsert' | 'create' | 'replace' }
      : {}),
    ...(typeof value.createParents === 'boolean' ? { createParents: value.createParents } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  };
}

function parseCreateDirectoryOptions(value: unknown): FileSystemCreateDirectoryOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['mode', 'createParents'])) {
    throw new Error('Invalid create-directory options');
  }
  if (value.mode !== undefined && value.mode !== 'ensure' && value.mode !== 'create') {
    throw new Error('Invalid create-directory mode');
  }
  if (value.createParents !== undefined && typeof value.createParents !== 'boolean') {
    throw new Error('Invalid filesystem createParents option');
  }
  return {
    ...(value.mode === 'ensure' || value.mode === 'create' ? { mode: value.mode } : {}),
    ...(typeof value.createParents === 'boolean' ? { createParents: value.createParents } : {}),
  };
}

function parseRemoveOptions(value: unknown): FileSystemRemoveOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['recursive', 'missing', 'expectedVersion'])) {
    throw new Error('Invalid filesystem remove options');
  }
  if (value.recursive !== undefined && typeof value.recursive !== 'boolean') {
    throw new Error('Invalid recursive option');
  }
  if (value.missing !== undefined && value.missing !== 'ignore' && value.missing !== 'error') {
    throw new Error('Invalid missing-entry option');
  }
  const expectedVersion = parseVersion(value.expectedVersion);
  return {
    ...(typeof value.recursive === 'boolean' ? { recursive: value.recursive } : {}),
    ...(value.missing === 'ignore' || value.missing === 'error' ? { missing: value.missing } : {}),
    ...(expectedVersion !== undefined && expectedVersion !== null ? { expectedVersion } : {}),
  };
}

function parseMoveOptions(value: unknown): FileSystemMoveOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['createParents', 'expectedVersion'])) {
    throw new Error('Invalid filesystem move options');
  }
  if (value.createParents !== undefined && typeof value.createParents !== 'boolean') {
    throw new Error('Invalid filesystem createParents option');
  }
  const expectedVersion = parseVersion(value.expectedVersion);
  return {
    ...(typeof value.createParents === 'boolean' ? { createParents: value.createParents } : {}),
    ...(expectedVersion !== undefined && expectedVersion !== null ? { expectedVersion } : {}),
  };
}

function parseOpenRequest(value: unknown): HostFileSystemV2OpenRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['instanceId', 'providerId', 'label'])) {
    throw new Error('Invalid filesystem open request');
  }
  const instanceId = parseIdentifier(value.instanceId, 'provider instance');
  const providerId = parseIdentifier(value.providerId, 'workspace');
  if (!isBoundedString(value.label, HOST_WIRE_LIMITS.labelCharacters, 1)) {
    throw new Error('Invalid provider label');
  }
  return { instanceId, providerId, label: value.label };
}

export function registerFsV2Ipc(service = new FileSystemV2IpcService()): void {
  const owners = new Map<number, OwnerRecord>();

  const owner = (sender: WebContents): string => {
    const existing = owners.get(sender.id);
    if (existing) return existing.key;
    const record: OwnerRecord = { key: `${sender.id}:${randomUUID()}`, sender };
    owners.set(sender.id, record);
    bindOwnerGrantRevocation(sender, () => {
      if (owners.get(sender.id) !== record) return;
      owners.delete(sender.id);
      void service.disposeOwner(record.key);
    });
    return record.key;
  };

  registerTrustedIpcHandler('fs:v2:open', 1, (event, requestValue: unknown) => {
    const request = parseOpenRequest(requestValue);
    const workspace = getWorkspaceRoots().get(request.providerId);
    if (!workspace) throw new Error('Workspace capability is not registered');
    return service.open(owner(event.sender), request, workspace.rootPath);
  });
  registerTrustedIpcHandler('fs:v2:stat', 2, (event, instanceId: unknown, itemPath: unknown) =>
    service.stat(
      owner(event.sender),
      parseIdentifier(instanceId, 'provider instance'),
      parsePath(itemPath),
    ),
  );
  registerTrustedIpcHandler('fs:v2:readFile', 2, (event, instanceId: unknown, itemPath: unknown) =>
    service.readFile(
      owner(event.sender),
      parseIdentifier(instanceId, 'provider instance'),
      parsePath(itemPath),
    ),
  );
  registerTrustedIpcHandler(
    'fs:v2:readDirectory',
    2,
    (event, instanceId: unknown, itemPath: unknown) =>
      service.readDirectory(
        owner(event.sender),
        parseIdentifier(instanceId, 'provider instance'),
        parsePath(itemPath),
      ),
  );
  registerTrustedIpcHandler(
    'fs:v2:writeFile',
    [3, 4],
    (event, instanceId: unknown, itemPath: unknown, data: unknown, options?: unknown) => {
      if (!isBoundedBytePayload(data)) throw new Error('Filesystem payload exceeds the limit');
      return service.writeFile(
        owner(event.sender),
        parseIdentifier(instanceId, 'provider instance'),
        parsePath(itemPath),
        data,
        parseWriteOptions(options),
      );
    },
  );
  registerTrustedIpcHandler(
    'fs:v2:createDirectory',
    [2, 3],
    (event, instanceId: unknown, itemPath: unknown, options?: unknown) =>
      service.createDirectory(
        owner(event.sender),
        parseIdentifier(instanceId, 'provider instance'),
        parsePath(itemPath),
        parseCreateDirectoryOptions(options),
      ),
  );
  registerTrustedIpcHandler(
    'fs:v2:remove',
    [2, 3],
    (event, instanceId: unknown, itemPath: unknown, options?: unknown) =>
      service.remove(
        owner(event.sender),
        parseIdentifier(instanceId, 'provider instance'),
        parsePath(itemPath),
        parseRemoveOptions(options),
      ),
  );
  registerTrustedIpcHandler(
    'fs:v2:move',
    [3, 4],
    (event, instanceId: unknown, oldPath: unknown, newPath: unknown, options?: unknown) =>
      service.move(
        owner(event.sender),
        parseIdentifier(instanceId, 'provider instance'),
        parsePath(oldPath),
        parsePath(newPath),
        parseMoveOptions(options),
      ),
  );
  registerTrustedIpcHandler('fs:v2:snapshot', 1, (event, instanceId: unknown) =>
    service.snapshot(owner(event.sender), parseIdentifier(instanceId, 'provider instance')),
  );
  registerTrustedIpcHandler(
    'fs:v2:watchSubscribe',
    2,
    (event, instanceId: unknown, subscriptionId: unknown) => {
      const sender = event.sender;
      return service.watchSubscribe(
        owner(sender),
        parseIdentifier(instanceId, 'provider instance'),
        parseIdentifier(subscriptionId, 'watch subscription'),
        (message) => {
          if (!sender.isDestroyed()) sender.send('fs:v2:watchMessage', message);
        },
      );
    },
  );
  registerTrustedIpcHandler(
    'fs:v2:watchUnsubscribe',
    2,
    (event, instanceId: unknown, subscriptionId: unknown) =>
      service.watchUnsubscribe(
        owner(event.sender),
        parseIdentifier(instanceId, 'provider instance'),
        parseIdentifier(subscriptionId, 'watch subscription'),
      ),
  );
  registerTrustedIpcHandler('fs:v2:dispose', 1, (event, instanceId: unknown) =>
    service.dispose(owner(event.sender), parseIdentifier(instanceId, 'provider instance')),
  );
}
