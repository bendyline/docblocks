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
import { BrowserWindow, app, safeStorage } from 'electron';
import type { WebContents } from 'electron';
import {
  HOST_WIRE_LIMITS,
  isBoundedString,
  parseAiChatRequest,
  parseAiKnowledgeAction,
  parseAiPreferencesPatch,
} from '@bendyline/docblocks/host';
import type { AiChatEvent, AiModelInstallEvent } from '@bendyline/docblocks/host';

import { registerTrustedIpcHandler } from './ipc-authority.js';
import { EncryptedFileCredentialStore } from './ai/ai-credentials.js';
import { createSettingsAiPreferenceStore } from './ai/ai-preferences.js';
import { AiService } from './ai/ai-service.js';
import { GezelConnector } from './ai/gezel-connector.js';
import { resolveGezelNativeHost } from './ai/gezel-native-host.js';
import { readSettings, updateSettings } from './settings.js';

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function createAiService(): AiService {
  const macAppStore = process.mas === true;
  const credentials = new EncryptedFileCredentialStore(
    path.join(app.getPath('userData'), 'ai', 'gezel-credential.bin'),
    safeStorage,
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

function streamKey(ownerId: number, requestId: string): string {
  return `${ownerId}:${requestId}`;
}

function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw new Error('Invalid AI request id');
  }
  return value;
}

export function registerAiIpc(service: AiService): void {
  /** Live request ids per renderer, so cleanup can find them. */
  const chatOwners = new Map<number, Set<string>>();
  const installOwners = new Map<number, Set<string>>();
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
}
