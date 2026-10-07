import { z } from 'zod';
import { parseWorkspacePath } from '../filesystem/workspace-path.js';
import { parseFileSystemVersion } from '../filesystem/v2.js';
import { parseFileSystemCapabilities } from '../filesystem/capabilities.js';
import { FsError, deserializeFsError, isSerializedFsError } from '../filesystem/fs-error.js';
import type { DocBlocksHostFsV2API, HostFileSystemV2Result } from './filesystem-v2.js';

export const MOBILE_STORAGE_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  totalBytes: 32 * 1024 * 1024,
  entries: 10_000,
  transfers: 4,
});
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);
const path = z
  .string()
  .max(4096)
  .refine((value) => parseWorkspacePath(value) === value, 'Native paths must be canonical.');
const version = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes('\0'));
const integer = z.number().int().nonnegative();
const entryFields = {
  path: path.transform(parseWorkspacePath),
  name: z.string().max(4096),
  version: version.transform(parseFileSystemVersion),
  lastModified: z.string().datetime(),
};
const file = z
  .object({
    ...entryFields,
    kind: z.literal('file'),
    size: integer.max(MOBILE_STORAGE_LIMITS.fileBytes),
  })
  .strict();
const directory = z
  .object({ ...entryFields, kind: z.literal('directory'), size: z.null() })
  .strict();
const entry = z.union([file, directory]);
const base64 = z
  .string()
  .max(Math.ceil(MOBILE_STORAGE_LIMITS.fileBytes / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);
const writeOptions = z
  .object({
    mode: z.enum(['upsert', 'create', 'replace']).optional(),
    createParents: z.boolean().optional(),
    expectedVersion: version.nullable().optional(),
  })
  .strict();
const mkdirOptions = z
  .object({ mode: z.enum(['ensure', 'create']).optional(), createParents: z.boolean().optional() })
  .strict();
const removeOptions = z
  .object({
    recursive: z.boolean().optional(),
    missing: z.enum(['ignore', 'error']).optional(),
    expectedVersion: version.optional(),
  })
  .strict();
const moveOptions = z
  .object({ createParents: z.boolean().optional(), expectedVersion: version.optional() })
  .strict();
const instance = { instanceId: id };
const location = { ...instance, path };
const transfer = { ...instance, transferId: id };
const mobileRequests = {
  open: z
    .object({ op: z.literal('open'), ...instance, providerId: id, label: z.string().max(1024) })
    .strict(),
  stat: z.object({ op: z.literal('stat'), ...location }).strict(),
  list: z.object({ op: z.literal('list'), ...location }).strict(),
  readBegin: z.object({ op: z.literal('readBegin'), ...location }).strict(),
  readChunk: z
    .object({
      op: z.literal('readChunk'),
      ...transfer,
      offset: integer.max(MOBILE_STORAGE_LIMITS.fileBytes),
    })
    .strict(),
  writeBegin: z
    .object({
      op: z.literal('writeBegin'),
      ...location,
      byteLength: integer.max(MOBILE_STORAGE_LIMITS.fileBytes),
      options: writeOptions,
    })
    .strict(),
  writeChunk: z
    .object({
      op: z.literal('writeChunk'),
      ...transfer,
      offset: integer.max(MOBILE_STORAGE_LIMITS.fileBytes),
      data: base64.max(Math.ceil(MOBILE_STORAGE_LIMITS.chunkBytes / 3) * 4),
    })
    .strict(),
  writeFinish: z.object({ op: z.literal('writeFinish'), ...transfer }).strict(),
  closeTransfer: z.object({ op: z.literal('closeTransfer'), ...transfer }).strict(),
  mkdir: z.object({ op: z.literal('mkdir'), ...location, options: mkdirOptions }).strict(),
  remove: z.object({ op: z.literal('remove'), ...location, options: removeOptions }).strict(),
  move: z
    .object({
      op: z.literal('move'),
      ...instance,
      oldPath: path,
      newPath: path,
      options: moveOptions,
    })
    .strict(),
  snapshot: z.object({ op: z.literal('snapshot'), ...instance }).strict(),
  dispose: z.object({ op: z.literal('dispose'), ...instance }).strict(),
};
export type MobileFsRequest = {
  [K in keyof typeof mobileRequests]: z.infer<(typeof mobileRequests)[K]>;
}[keyof typeof mobileRequests];
export type MobileNativeSend = (request: MobileFsRequest) => Promise<unknown>;

const envelope = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.unknown() }).strict(),
]);
export function parseMobileResult<T>(input: unknown, parse: (value: unknown) => T): T {
  const result = envelope.parse(input);
  if (!result.ok) {
    if (!isSerializedFsError(result.error) || Object.keys(result.error).length !== 7)
      throw new TypeError('Invalid native filesystem error.');
    throw deserializeFsError(result.error);
  }
  return parse(result.value);
}
export function encodeMobileBytes(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > MOBILE_STORAGE_LIMITS.chunkBytes)
    throw new RangeError('Mobile chunk exceeds its budget.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function decodeBytes(input: unknown): ArrayBuffer {
  const value = base64.parse(input);
  const binary = atob(value);
  if (value.length % 4 !== 0 || btoa(binary) !== value)
    throw new TypeError('Invalid native Base64 payload.');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}
const readTransfer = z.object({ transferId: id, entry: file }).strict().nullable();
const snapshot = z
  .object({
    version: version.transform(parseFileSystemVersion),
    entries: z
      .array(z.union([directory, file.extend({ data: base64 }).strict()]))
      .max(MOBILE_STORAGE_LIMITS.entries),
  })
  .strict();

/** JSON-safe transport shared by Capacitor and the real-native conformance runner. */
export function createMobileFileSystemBridge(
  send: MobileNativeSend,
  capabilities: ReturnType<typeof parseFileSystemCapabilities>,
): DocBlocksHostFsV2API {
  async function call<T>(
    request: MobileFsRequest,
    parse: (value: unknown) => T,
  ): Promise<HostFileSystemV2Result<T>> {
    const validated = mobileRequests[request.op].parse(request) as MobileFsRequest;
    try {
      return { ok: true, value: parseMobileResult(await send(validated), parse) };
    } catch (error) {
      if (error instanceof FsError) return { ok: false, error: error.toJSON() };
      throw error;
    }
  }
  const nullResult = (value: unknown) => z.null().parse(value);
  const unwrap = <T>(result: HostFileSystemV2Result<T>): T => {
    if (!result.ok) throw deserializeFsError(result.error);
    return result.value;
  };
  const bridge: DocBlocksHostFsV2API = {
    capabilitiesFor: () => capabilities,
    transferLimits: MOBILE_STORAGE_LIMITS,
    open: (request) => call({ op: 'open', ...request }, parseFileSystemCapabilities),
    stat: (instanceId, path) =>
      call({ op: 'stat', instanceId, path }, (value) => entry.nullable().parse(value)),
    readDirectory: (instanceId, path) =>
      call({ op: 'list', instanceId, path }, (value) =>
        z.array(entry).max(MOBILE_STORAGE_LIMITS.entries).parse(value),
      ),
    beginRead: (instanceId, path) =>
      call({ op: 'readBegin', instanceId, path }, (value) => readTransfer.parse(value)),
    readChunk: (instanceId, transferId, offset) =>
      call({ op: 'readChunk', instanceId, transferId, offset }, (value) => {
        const bytes = decodeBytes(value);
        if (bytes.byteLength > MOBILE_STORAGE_LIMITS.chunkBytes)
          throw new TypeError('Oversized native read chunk.');
        return bytes;
      }),
    beginWrite: (instanceId, path, byteLength, options = {}) =>
      call({ op: 'writeBegin', instanceId, path, byteLength, options }, (value) => id.parse(value)),
    writeChunk: (instanceId, transferId, offset, data) =>
      call(
        { op: 'writeChunk', instanceId, transferId, offset, data: encodeMobileBytes(data) },
        nullResult,
      ),
    finishWrite: (instanceId, transferId) =>
      call({ op: 'writeFinish', instanceId, transferId }, (value) => file.parse(value)),
    closeTransfer: (instanceId, transferId) =>
      call({ op: 'closeTransfer', instanceId, transferId }, nullResult),
    async readFile(instanceId, path) {
      let transferId: string | undefined;
      try {
        const transfer = unwrap(await bridge.beginRead!(instanceId, path));
        if (!transfer) return { ok: true, value: null };
        transferId = transfer.transferId;
        const bytes = new Uint8Array(transfer.entry.size);
        for (let offset = 0; offset < bytes.length; ) {
          const chunk = new Uint8Array(
            unwrap(await bridge.readChunk!(instanceId, transferId, offset)),
          );
          if (!chunk.length || offset + chunk.length > bytes.length)
            throw new TypeError('Invalid native read length.');
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return { ok: true, value: { entry: transfer.entry, data: bytes.buffer } };
      } catch (error) {
        if (error instanceof FsError) return { ok: false, error: error.toJSON() };
        throw error;
      } finally {
        if (transferId) unwrap(await bridge.closeTransfer!(instanceId, transferId));
      }
    },
    async writeFile(instanceId, path, data, options = {}) {
      let transferId: string | undefined;
      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        transferId = unwrap(await bridge.beginWrite!(instanceId, path, bytes.length, options));
        for (let offset = 0; offset < bytes.length; offset += MOBILE_STORAGE_LIMITS.chunkBytes)
          unwrap(
            await bridge.writeChunk!(
              instanceId,
              transferId,
              offset,
              bytes.subarray(offset, offset + MOBILE_STORAGE_LIMITS.chunkBytes),
            ),
          );
        return await bridge.finishWrite!(instanceId, transferId);
      } catch (error) {
        if (error instanceof FsError) return { ok: false, error: error.toJSON() };
        throw error;
      } finally {
        if (transferId) unwrap(await bridge.closeTransfer!(instanceId, transferId));
      }
    },
    createDirectory: (instanceId, path, options = {}) =>
      call({ op: 'mkdir', instanceId, path, options }, (value) => directory.parse(value)),
    remove: (instanceId, path, options = {}) =>
      call({ op: 'remove', instanceId, path, options }, (value) =>
        z
          .object({ removed: z.boolean(), version: version.transform(parseFileSystemVersion) })
          .strict()
          .parse(value),
      ),
    move: (instanceId, oldPath, newPath, options = {}) =>
      call({ op: 'move', instanceId, oldPath, newPath, options }, (value) => entry.parse(value)),
    snapshot: (instanceId) =>
      call({ op: 'snapshot', instanceId }, (value) => {
        const parsed = snapshot.parse(value);
        let total = 0;
        return {
          version: parsed.version,
          entries: parsed.entries.map((item) => {
            if (item.kind === 'directory') return item;
            const data = decodeBytes(item.data);
            total += data.byteLength;
            if (total > MOBILE_STORAGE_LIMITS.totalBytes || data.byteLength !== item.size)
              throw new TypeError('Invalid native snapshot size.');
            return { ...item, data };
          }),
        };
      }),
    dispose: (instanceId) => call({ op: 'dispose', instanceId }, nullResult),
    watchSubscribe: async () => ({
      ok: false,
      error: new FsError('not-supported', 'Native workspace watching is unavailable.', {
        operation: 'watch',
      }).toJSON(),
    }),
    watchUnsubscribe: async () => ({ ok: true, value: null }),
    onWatchMessage: () => () => {},
  };
  return bridge;
}

const workspace = z
  .object({ id, name: z.string().min(1).max(1024), rootPath: z.string().min(1).max(4096) })
  .strict();
export function parseMobileBootstrap(value: unknown) {
  return z
    .object({
      env: z
        .object({
          surface: z.literal('capacitor'),
          surfaceLabel: z.enum(['iOS', 'Android']),
          platform: z.enum(['ios', 'android']),
          appVersion: z.string().min(1).max(256),
          isDev: z.boolean(),
        })
        .strict(),
      workspaces: z.array(workspace).min(1).max(64),
      folderPicker: z.boolean(),
      capabilities: z.unknown().transform(parseFileSystemCapabilities),
    })
    .strict()
    .parse(value);
}

const exportFilename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      name !== '.' &&
      name !== '..' &&
      !/[\\/:]/.test(name) &&
      [...name].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
const mobileExportRequests = {
  begin: z
    .object({
      op: z.literal('begin'),
      filename: exportFilename,
      byteLength: integer.max(MOBILE_STORAGE_LIMITS.fileBytes),
    })
    .strict(),
  append: z
    .object({
      op: z.literal('append'),
      transferId: id,
      offset: integer.max(MOBILE_STORAGE_LIMITS.fileBytes),
      data: base64.max(Math.ceil(MOBILE_STORAGE_LIMITS.chunkBytes / 3) * 4),
    })
    .strict(),
  finish: z
    .object({ op: z.literal('finish'), transferId: id, action: z.enum(['save', 'share']) })
    .strict(),
  cancel: z.object({ op: z.literal('cancel'), transferId: id }).strict(),
};
export type MobileExportRequest = {
  [K in keyof typeof mobileExportRequests]: z.infer<(typeof mobileExportRequests)[K]>;
}[keyof typeof mobileExportRequests];
export function parseMobileExportRequest(input: MobileExportRequest): MobileExportRequest {
  return mobileExportRequests[input.op].parse(input);
}
export function parseMobileExportToken(input: unknown): string {
  return z.object({ transferId: id }).strict().parse(input).transferId;
}
export function parseMobileExportOutcome(
  input: unknown,
): 'saved' | 'shared' | 'presented' | 'cancelled' {
  return z
    .object({ outcome: z.enum(['saved', 'shared', 'presented', 'cancelled']) })
    .strict()
    .parse(input).outcome;
}

export function parseMobileOpenRequests(input: unknown) {
  return z
    .object({
      requests: z
        .array(
          z
            .object({
              kind: z.literal('workspace-file'),
              workspaceId: id,
              path: z
                .string()
                .min(1)
                .max(4097)
                .refine(
                  (value) => value.startsWith('/') && parseWorkspacePath(value) === value.slice(1),
                ),
            })
            .strict(),
        )
        .max(8),
    })
    .strict()
    .parse(input).requests;
}

export function parseMobilePickedFolder(input: unknown) {
  return z.object({ workspace: workspace.nullable() }).strict().parse(input).workspace;
}
