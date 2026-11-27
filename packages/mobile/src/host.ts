import { Capacitor } from '@capacitor/core';
import { native } from './native';
import { installMobileAi } from './ai';
import { installMobileSpeech } from './speech';
import { installMobileEmbeddings } from './embeddings';
import { installMobileNotifications } from './notifications';
import { routeExternalLinks } from './external-links';
import { installNativePrint } from './print';
import { installNativeWakeLock } from './wake-lock';
import { ensureStorageChosen } from './storage-welcome';
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
} from '@bendyline/docblocks/host/mobile';
import { publishFileSystemChangeHint } from '@bendyline/docblocks/filesystem';
import {
  parseOpenExternalUrl,
  type DocBlocksHostAPI,
  type HostPrepareCloseRequest,
  type HostPrepareCloseResult,
  type OpenRequest,
} from '@bendyline/docblocks/host';

export async function installMobileHost(): Promise<void> {
  if (Capacitor.getPlatform() === 'android') await ensureStorageChosen();
  const info = parseMobileBootstrap(await native.bootstrap());
  const mobileAi = Capacitor.isPluginAvailable('GezelRuntime') ? installMobileAi() : undefined;
  const mobileSpeech = Capacitor.isPluginAvailable('GezelOfflineSpeech')
    ? installMobileSpeech()
    : undefined;
  const prepare = new Set<(request: HostPrepareCloseRequest) => Promise<HostPrepareCloseResult>>();
  const resume = new Set<() => void>();
  const back = new Set<() => boolean>();
  const opens = new Set<(request: OpenRequest) => void>();
  let draining: Promise<void> | undefined;
  let drainAgain = false;
  const drainOpenRequests = (): Promise<void> => {
    // A share that arrives while a drain is under way is taken by another
    // pass, not left queued until the next share.
    if (draining) {
      drainAgain = true;
      return draining;
    }
    draining = (async () => {
      do {
        drainAgain = false;
        if (!opens.size) return;
        for (const request of parseMobileOpenRequests(await native.takeOpenRequests()))
          for (const listener of opens) listener(request);
      } while (drainAgain);
    })().finally(() => {
      draining = undefined;
    });
    return draining;
  };
  // Reminders, when the app includes the local notifications plugin. A tapped
  // reminder opens its document like any other open request. The tap that
  // launched the app arrives before the shell listens, so it is held for it.
  const heldOpens: OpenRequest[] = [];
  const mobileNotifications = installMobileNotifications((request) => {
    if (opens.size === 0) {
      if (heldOpens.length < 4) heldOpens.push(request);
      return;
    }
    for (const listener of opens) listener(request);
  });
  const openExternal = async (value: string) => {
    const url = parseOpenExternalUrl(value);
    if (!url) throw new TypeError('Invalid external URL.');
    await native.openExternal({ url });
  };
  const host: DocBlocksHostAPI = {
    env: info.env,
    ...(mobileAi ? { ai: mobileAi.ai } : {}),
    ...(mobileSpeech ? { speech: mobileSpeech.speech } : {}),
    // Semantic search embeds with the knowledge plugin's on-device model.
    ...(Capacitor.isPluginAvailable('GezelKnowledge')
      ? { embeddings: installMobileEmbeddings() }
      : {}),
    ...(mobileNotifications ? { notifications: mobileNotifications } : {}),
    fsV2: createMobileFileSystemBridge((request) => native.request({ request }), info.capabilities),
    workspaces: {
      // Native lists the current default workspace first; it can change after
      // launch (Android's first-launch folder is forgotten, for example).
      list: async () =>
        parseMobileBootstrap(await native.bootstrap()).workspaces.map((workspace, index) =>
          index === 0 ? { ...workspace, isDefault: true } : workspace,
        ),
      ...(info.folderPicker
        ? { pickFolder: async () => parseMobilePickedFolder(await native.pickFolder()) }
        : {}),
      getDefault: async () => ({ ...parseMobileBootstrap(await native.bootstrap()).workspaces[0] }),
      register: async (id) => {
        if (
          !parseMobileBootstrap(await native.bootstrap()).workspaces.some(
            (workspace) => workspace.id === id,
          )
        )
          throw new Error('Workspace permission is unavailable.');
      },
      unregister: (id) => native.forgetFolder({ workspaceId: id }),
      // Android's default is a choice the user can revisit: moving device
      // documents into a folder makes that folder the default.
      ...(Capacitor.getPlatform() === 'android'
        ? { setDefault: (id: string) => native.setDefaultFolder({ workspaceId: id }) }
        : {}),
    },
    shell: { openExternal },
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
        if (outcome === 'saved' || outcome === 'printed')
          throw new Error('Unexpected native share outcome.');
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
      for (const request of heldOpens.splice(0)) listener(request);
      void drainOpenRequests().catch(reportImportError);
      return () => {
        opens.delete(listener);
      };
    },
  };
  (globalThis as typeof globalThis & { docBlocksHost: DocBlocksHostAPI }).docBlocksHost = host;
  routeExternalLinks(openExternal);
  installNativeWakeLock((on) => native.setKeepAwake({ on }));
  installNativePrint(
    {
      printPage: async (jobName) => {
        parseMobileExportOutcome(await native.printPage({ jobName }));
      },
      printDocument: async (jobName, html) => {
        await exportBytes(`${jobName}.html`, new TextEncoder().encode(html), 'print');
      },
    },
    reportPrintError,
  );
  window.addEventListener('pagehide', () => {
    mobileAi?.suspend();
    mobileSpeech?.suspend();
  });
  mobileAi?.resume();
  window.addEventListener('docblocksIncoming', () => {
    void drainOpenRequests().catch(reportImportError);
  });
  // Native saw synced files change (iCloud delivered or took a document). It
  // cannot say which, so everything on screen re-checks itself, cheaply.
  window.addEventListener('docblocksStorageChanged', () => publishFileSystemChangeHint());
  window.addEventListener('docblocksNativeBack', () => {
    if (![...back].reverse().some((listener) => listener())) void native.backUnhandled();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      mobileAi?.suspend();
      mobileSpeech?.suspend();
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
      mobileSpeech?.resume();
      for (const listener of resume) listener();
      void drainOpenRequests().catch(reportImportError);
    }
  });
}

async function exportBytes(
  filename: string,
  data: ArrayBuffer | Uint8Array,
  action: 'save' | 'share' | 'print',
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

function reportPrintError(error: unknown) {
  window.alert(error instanceof Error ? error.message : 'The document could not be printed.');
}

function reportImportError(error: unknown) {
  // Native import is independent of the active document; keep its failure visible.
  const message = error instanceof Error ? error.message : 'The document could not be imported.';
  window.alert(message);
}
