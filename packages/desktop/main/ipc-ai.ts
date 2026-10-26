/**
 * IPC for `DocBlocksHostAiAPI`.
 *
 * Every handler is owner- and origin-checked and parses its arguments with the
 * shared AI wire policy. Streams are addressed by `(webContents, requestId)`:
 * the preload mints the id, and main scopes it to the renderer that started
 * the stream, so one renderer can neither cancel nor observe another's. A
 * renderer that reloads, navigates, crashes, or closes has its streams
 * cancelled — nobody is left to read them.
 */

import path from 'node:path';
import { BrowserWindow, app } from 'electron';
import type { WebContents } from 'electron';
import {
  HOST_WIRE_LIMITS,
  isAiImageModelId,
  isBoundedString,
  parseAiChatRequest,
  parseAiFactCheckRequest,
  parseAiImagePreferencesPatch,
  parseAiImageRequest,
  parseAiKnowledgeAction,
  parseAiPreferencesPatch,
} from '@bendyline/docblocks/host';
import type {
  AiChatEvent,
  AiImageEvent,
  AiImageInstallEvent,
  AiModelInstallEvent,
} from '@bendyline/docblocks/host';

import { registerTrustedIpcHandler } from './ipc-authority.js';
import { OwnerOnlyFileCredentialStore } from './ai/ai-credentials.js';
import { createSettingsAiPreferenceStore } from './ai/ai-preferences.js';
import { AiImageService } from './ai/ai-image-service.js';
import { AiService } from './ai/ai-service.js';
import { checkFacts } from './ai/fact-check.js';
import { GezelConnector } from './ai/gezel-connector.js';
import { resolveGezelNativeHost } from './ai/gezel-native-host.js';
import { imageGraphicsDriverBlock } from './ai/graphics-driver.js';
import { ImagePreferenceStore } from './ai/image-preferences.js';
import { readSettings, updateSettings } from './settings.js';

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function createAiService(): AiService {
  const macAppStore = process.mas === true;
  const credentials = new OwnerOnlyFileCredentialStore(
    path.join(app.getPath('userData'), 'ai', 'gezel-credential.bin'),
  );
  return new AiService({
    connector: new GezelConnector({
      credentials,
      // Capture the person's Gezel home before the SDK temporarily points
      // GEZEL_HOME at DocBlocks' private hosted service. Detection and the
      // optional Connect action must continue to mean the standalone app.
      ...(macAppStore
        ? { hostHome: path.join(app.getPath('userData'), 'ai', 'gezel'), standalone: false }
        : { home: process.env.GEZEL_HOME?.trim() || path.join(app.getPath('home'), '.gezel') }),
      // Enabling AI is sufficient consent to run a private Gezel for
      // DocBlocks. Connecting the person's standalone Gezel remains optional.
      hostInProcess: true,
      hostNative: resolveGezelNativeHost(
        app.isPackaged,
        process.resourcesPath,
        process.env,
        process.platform,
        process.arch,
        macAppStore,
      ),
    }),
    preferences: createSettingsAiPreferenceStore({ read: readSettings, update: updateSettings }),
  });
}

/** Image generation rides the AI connection; the Mac App Store build ships no image engine. */
export function createAiImageService(service: AiService): AiImageService | null {
  if (process.mas === true) return null;
  return new AiImageService({
    images: () => service.imageProvider(),
    status: () => service.getStatus(),
    onStatus: (listener) => service.onStatus(listener),
    preferences: new ImagePreferenceStore(path.join(app.getPath('userData'), 'ai', 'images.json')),
    blocked: () => imageGraphicsDriverBlock(),
  });
}

function streamKey(ownerId: number, requestId: string): string {
  return `${ownerId}:${requestId}`;
}

function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw new Error('Invalid AI request id');
  }
  return value;
}

export function registerAiIpc(service: AiService, images: AiImageService | null = null): void {
  /** Live request ids per renderer, so cleanup can find them. */
  const chatOwners = new Map<number, Set<string>>();
  const installOwners = new Map<number, Set<string>>();
  const renderOwners = new Map<number, Set<string>>();
  const imageInstallOwners = new Map<number, Set<string>>();
  const watched = new WeakSet<WebContents>();

  service.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send('ai:status', status);
    }
  });

  const release = (ownerId: number) => {
    service.cancelKnowledge(`${ownerId}:knowledge`);
    const chatIds = chatOwners.get(ownerId);
    chatOwners.delete(ownerId);
    for (const requestId of chatIds ?? []) service.cancelChat(streamKey(ownerId, requestId));
    const installIds = installOwners.get(ownerId);
    installOwners.delete(ownerId);
    for (const requestId of installIds ?? []) {
      service.cancelModelInstall(streamKey(ownerId, requestId));
    }
    const renderIds = renderOwners.get(ownerId);
    renderOwners.delete(ownerId);
    for (const requestId of renderIds ?? []) images?.cancelGenerate(streamKey(ownerId, requestId));
    const imageInstallIds = imageInstallOwners.get(ownerId);
    imageInstallOwners.delete(ownerId);
    for (const requestId of imageInstallIds ?? []) {
      images?.cancelInstall(streamKey(ownerId, requestId));
    }
  };

  /** Claim a renderer-minted id for one stream; a reused id is a bug in the caller. */
  const claim = (owners: Map<number, Set<string>>, ownerId: number, requestId: string) => {
    let ids = owners.get(ownerId);
    if (!ids) {
      ids = new Set();
      owners.set(ownerId, ids);
    }
    if (ids.has(requestId)) throw new Error('Duplicate AI request id');
    ids.add(requestId);
  };

  const watch = (sender: WebContents) => {
    if (watched.has(sender)) return;
    watched.add(sender);
    const ownerId = sender.id;
    sender.once('destroyed', () => release(ownerId));
    sender.on('render-process-gone', () => release(ownerId));
    // Main-frame navigations only; in-page navigations keep the document.
    sender.on('did-navigate', () => release(ownerId));
  };

  registerTrustedIpcHandler('ai:providerInstalled', 0, () => service.providerInstalled());
  registerTrustedIpcHandler('ai:status', 0, () => service.getStatus());
  registerTrustedIpcHandler('ai:getPreferences', 0, () => service.getPreferences());

  registerTrustedIpcHandler('ai:setPreferences', 1, (_event, value: unknown) => {
    const patch = parseAiPreferencesPatch(value);
    if (!patch) throw new Error('Invalid AI preferences');
    return service.setPreferences(patch);
  });

  registerTrustedIpcHandler('ai:connect', 0, () => service.connect());
  registerTrustedIpcHandler('ai:disconnect', 0, () => service.disconnect());
  registerTrustedIpcHandler('ai:models', 0, () => service.listModels());
  registerTrustedIpcHandler('ai:availableModels', 0, () => service.listAvailableModels());
  // Mechanical and provider-free: it works whatever the connection state.
  registerTrustedIpcHandler('ai:checkFacts', 1, (_event, value: unknown) => {
    const request = parseAiFactCheckRequest(value);
    if (!request) throw new Error('Invalid fact check request');
    return { ok: true, value: checkFacts(request) };
  });
  registerTrustedIpcHandler('ai:knowledge:state', 0, (event) => {
    watch(event.sender);
    return service.knowledgeState(`${event.sender.id}:knowledge`);
  });
  registerTrustedIpcHandler('ai:knowledge:update', 1, (event, value: unknown) => {
    const action = parseAiKnowledgeAction(value);
    if (!action) throw new Error('Invalid knowledge catalog action');
    watch(event.sender);
    return service.updateKnowledge(`${event.sender.id}:knowledge`, action);
  });

  registerTrustedIpcHandler(
    'ai:chat:start',
    2,
    (event, requestIdValue: unknown, requestValue: unknown): void => {
      const requestId = parseRequestId(requestIdValue);
      const request = parseAiChatRequest(requestValue);
      if (!request) throw new Error('Invalid AI chat request');

      const sender = event.sender;
      const ownerId = sender.id;
      watch(sender);
      let ids = chatOwners.get(ownerId);
      if (!ids) {
        ids = new Set();
        chatOwners.set(ownerId, ids);
      }
      if (ids.has(requestId)) throw new Error('Duplicate AI request id');
      ids.add(requestId);

      service.startChat(streamKey(ownerId, requestId), request, (chatEvent: AiChatEvent) => {
        if (chatEvent.kind === 'done' || chatEvent.kind === 'error') {
          chatOwners.get(ownerId)?.delete(requestId);
        }
        if (!sender.isDestroyed()) sender.send('ai:chat:event', { requestId, event: chatEvent });
      });
    },
  );

  registerTrustedIpcHandler('ai:chat:cancel', 1, (event, requestIdValue: unknown): void => {
    const requestId = parseRequestId(requestIdValue);
    const ownerId = event.sender.id;
    if (chatOwners.get(ownerId)?.has(requestId)) {
      service.cancelChat(streamKey(ownerId, requestId));
    }
  });

  registerTrustedIpcHandler(
    'ai:modelInstall:start',
    2,
    (event, requestIdValue: unknown, modelIdValue: unknown): void => {
      const requestId = parseRequestId(requestIdValue);
      if (!isBoundedString(modelIdValue, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
        throw new Error('Invalid AI model id');
      }
      const sender = event.sender;
      const ownerId = sender.id;
      watch(sender);
      let ids = installOwners.get(ownerId);
      if (!ids) {
        ids = new Set();
        installOwners.set(ownerId, ids);
      }
      if (ids.has(requestId)) throw new Error('Duplicate AI model install id');
      ids.add(requestId);
      service.startModelInstall(
        streamKey(ownerId, requestId),
        modelIdValue,
        (installEvent: AiModelInstallEvent) => {
          if (installEvent.kind !== 'progress') installOwners.get(ownerId)?.delete(requestId);
          if (!sender.isDestroyed()) {
            sender.send('ai:modelInstall:event', { requestId, event: installEvent });
          }
        },
      );
    },
  );

  registerTrustedIpcHandler('ai:modelInstall:cancel', 1, (event, requestIdValue: unknown): void => {
    const requestId = parseRequestId(requestIdValue);
    const ownerId = event.sender.id;
    if (installOwners.get(ownerId)?.has(requestId)) {
      service.cancelModelInstall(streamKey(ownerId, requestId));
    }
  });

  if (images) registerImageIpc(images);

  function registerImageIpc(images: AiImageService): void {
    images.onAccess((access) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) win.webContents.send('ai:images:access', access);
      }
    });
    registerTrustedIpcHandler('ai:images:access', 0, () => images.access());
    registerTrustedIpcHandler('ai:images:requestAccess', 0, () => images.requestAccess());
    registerTrustedIpcHandler('ai:images:models', 0, () => images.models());
    registerTrustedIpcHandler('ai:images:remove', 1, (_event, value: unknown) => {
      if (!isAiImageModelId(value)) throw new Error('Invalid image model id');
      return images.removeModel(value);
    });
    registerTrustedIpcHandler('ai:images:getPreferences', 0, () => images.getPreferences());
    registerTrustedIpcHandler('ai:images:setPreferences', 1, (_event, value: unknown) => {
      const patch = parseAiImagePreferencesPatch(value);
      if (!patch) throw new Error('Invalid image preferences');
      return images.setPreferences(patch);
    });

    registerTrustedIpcHandler(
      'ai:images:generate:start',
      2,
      (event, requestIdValue: unknown, requestValue: unknown): void => {
        const requestId = parseRequestId(requestIdValue);
        const request = parseAiImageRequest(requestValue);
        if (!request) throw new Error('Invalid image request');
        const sender = event.sender;
        const ownerId = sender.id;
        watch(sender);
        claim(renderOwners, ownerId, requestId);
        images.startGenerate(streamKey(ownerId, requestId), request, (imageEvent: AiImageEvent) => {
          if (imageEvent.kind !== 'progress') renderOwners.get(ownerId)?.delete(requestId);
          if (!sender.isDestroyed()) {
            sender.send('ai:images:generate:event', { requestId, event: imageEvent });
          }
        });
      },
    );
    registerTrustedIpcHandler('ai:images:generate:cancel', 1, (event, requestIdValue: unknown) => {
      const requestId = parseRequestId(requestIdValue);
      const ownerId = event.sender.id;
      if (renderOwners.get(ownerId)?.has(requestId)) {
        images.cancelGenerate(streamKey(ownerId, requestId));
      }
    });

    registerTrustedIpcHandler(
      'ai:images:install:start',
      2,
      (event, requestIdValue: unknown, modelIdValue: unknown): void => {
        const requestId = parseRequestId(requestIdValue);
        if (!isAiImageModelId(modelIdValue)) throw new Error('Invalid image model id');
        const sender = event.sender;
        const ownerId = sender.id;
        watch(sender);
        claim(imageInstallOwners, ownerId, requestId);
        images.startInstall(
          streamKey(ownerId, requestId),
          modelIdValue,
          (installEvent: AiImageInstallEvent) => {
            if (installEvent.kind !== 'progress') {
              imageInstallOwners.get(ownerId)?.delete(requestId);
            }
            if (!sender.isDestroyed()) {
              sender.send('ai:images:install:event', { requestId, event: installEvent });
            }
          },
        );
      },
    );
    registerTrustedIpcHandler('ai:images:install:cancel', 1, (event, requestIdValue: unknown) => {
      const requestId = parseRequestId(requestIdValue);
      const ownerId = event.sender.id;
      if (imageInstallOwners.get(ownerId)?.has(requestId)) {
        images.cancelInstall(streamKey(ownerId, requestId));
      }
    });
  }
}
