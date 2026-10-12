import { Capacitor, registerPlugin } from '@capacitor/core';
import { installMobileAi } from './ai';
import {
  encodeMobileBytes,
  MOBILE_STORAGE_LIMITS,
  parseMobileExportRequest,
  parseMobileExportToken,
  parseMobileExportOutcome,
  type MobileExportRequest,
} from '@bendyline/docblocks/host/mobile';
import {
  createMobileFileSystemBridge,
  parseMobileBootstrap,
  parseMobileOpenRequests,
  parseMobilePickedFolder,
  type MobileFsRequest,
} from '@bendyline/docblocks/host/mobile';
import {
  parseExternalHttpUrl,
  type DocBlocksHostAPI,
  type HostPrepareCloseRequest,
  type HostPrepareCloseResult,
  type OpenRequest,
} from '@bendyline/docblocks/host';

interface MobilePlugin {
  bootstrap(): Promise<unknown>;
  exportFile(options: { request: MobileExportRequest }): Promise<unknown>;
  request(options: { request: MobileFsRequest }): Promise<unknown>;
  openExternal(options: { url: string }): Promise<void>;
  writeText(options: { text: string }): Promise<void>;
  backUnhandled(): Promise<void>;
  takeOpenRequests(): Promise<unknown>;
  pickFolder(): Promise<unknown>;
  forgetFolder(options: { workspaceId: string }): Promise<void>;
}
const native = registerPlugin<MobilePlugin>('DocBlocksMobile');

export async function installMobileHost(): Promise<void> {
  const info = parseMobileBootstrap(await native.bootstrap());
  const mobileAi = Capacitor.isPluginAvailable('GezelRuntime') ? installMobileAi() : undefined;
  const prepare = new Set<(request: HostPrepareCloseRequest) => Promise<HostPrepareCloseResult>>();
  const resume = new Set<() => void>();
  const back = new Set<() => boolean>();
  const opens = new Set<(request: OpenRequest) => void>();
  let draining: Promise<void> | undefined;
  const drainOpenRequests = () =>
    (draining ??= (async () => {
      if (!opens.size) return;
      for (const request of parseMobileOpenRequests(await native.takeOpenRequests()))
        for (const listener of opens) listener(request);
    })().finally(() => {
      draining = undefined;
    }));
  const host: DocBlocksHostAPI = {
    env: info.env,
    ...(mobileAi ? { ai: mobileAi.ai } : {}),
    fsV2: createMobileFileSystemBridge((request) => native.request({ request }), info.capabilities),
    workspaces: {
      // The first bootstrap workspace is the app's own storage, also returned
      // by getDefault(); picked folders follow it and are never default.
      list: async () =>
        parseMobileBootstrap(await native.bootstrap()).workspaces.map((workspace) =>
          workspace.id === info.workspaces[0]?.id ? { ...workspace, isDefault: true } : workspace,
        ),
      ...(info.folderPicker
        ? { pickFolder: async () => parseMobilePickedFolder(await native.pickFolder()) }
        : {}),
      getDefault: async () => ({ ...info.workspaces[0] }),
      register: async (id) => {
        if (
          !parseMobileBootstrap(await native.bootstrap()).workspaces.some(
            (workspace) => workspace.id === id,
          )
        )
          throw new Error('Workspace permission is unavailable.');
      },
      unregister: (id) => native.forgetFolder({ workspaceId: id }),
    },
    shell: {
      openExternal: async (value) => {
        const url = parseExternalHttpUrl(value);
        if (!url) throw new TypeError('Invalid external URL.');
        await native.openExternal({ url });
      },
    },
    clipboard: { writeText: (text) => native.writeText({ text }) },
    exports: {
      save: async (_documentId, filename, _grantId, data) => {
        const outcome = await exportBytes(filename, data, 'save');
        if (outcome === 'cancelled') return null;
        if (outcome !== 'saved') throw new Error('The native save did not complete.');
        return { grantId: null, displayPath: filename };
      },
      share: async (filename, data) => {
        const outcome = await exportBytes(filename, data, 'share');
        if (outcome === 'saved') throw new Error('Unexpected native share outcome.');
        return outcome;
      },
    },
    lifecycle: {
      onBack: (listener) => {
        back.add(listener);
        return () => {
          back.delete(listener);
        };
      },
      onPrepareClose: (listener) => {
        prepare.add(listener);
        return () => {
          prepare.delete(listener);
        };
      },
      onResume: (listener) => {
        resume.add(listener);
        return () => {
          resume.delete(listener);
        };
      },
    },
    onOpenRequest: (listener) => {
      opens.add(listener);
      void drainOpenRequests().catch(reportImportError);
      return () => {
        opens.delete(listener);
      };
    },
  };
  (globalThis as typeof globalThis & { docBlocksHost: DocBlocksHostAPI }).docBlocksHost = host;
  window.addEventListener('pagehide', () => mobileAi?.suspend());
  mobileAi?.resume();
  window.addEventListener('docblocksIncoming', () => {
    void drainOpenRequests().catch(reportImportError);
  });
  window.addEventListener('docblocksNativeBack', () => {
    if (![...back].reverse().some((listener) => listener())) void native.backUnhandled();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      mobileAi?.suspend();
      const request: HostPrepareCloseRequest = {
        requestId: crypto.randomUUID(),
        reason: 'app-background',
        deadline: Date.now() + 1500,
      };
      for (const listener of prepare)
        void listener(request).catch(() => {
          /* DocumentSession retains its error and recovery draft. */
        });
    } else {
      mobileAi?.resume();
      for (const listener of resume) listener();
      void drainOpenRequests().catch(reportImportError);
    }
  });
}

async function exportBytes(
  filename: string,
  data: ArrayBuffer | Uint8Array,
  action: 'save' | 'share',
) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const send = (request: MobileExportRequest) =>
    native.exportFile({ request: parseMobileExportRequest(request) });
  const transferId = parseMobileExportToken(
    await send({ op: 'begin', filename, byteLength: bytes.length }),
  );
  try {
    for (let offset = 0; offset < bytes.length; offset += MOBILE_STORAGE_LIMITS.chunkBytes) {
      await send({
        op: 'append',
        transferId,
        offset,
        data: encodeMobileBytes(bytes.subarray(offset, offset + MOBILE_STORAGE_LIMITS.chunkBytes)),
      });
    }
    return parseMobileExportOutcome(await send({ op: 'finish', transferId, action }));
  } finally {
    await send({ op: 'cancel', transferId });
  }
}

function reportImportError(error: unknown) {
  // Native import is independent of the active document; keep its failure visible.
  const message = error instanceof Error ? error.message : 'The document could not be imported.';
  window.alert(message);
}
