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
import { parseAiChatRequest, parseAiPreferencesPatch } from '@bendyline/docblocks/host';
import type { AiChatEvent } from '@bendyline/docblocks/host';

import { registerTrustedIpcHandler } from './ipc-authority.js';
import { EncryptedFileCredentialStore } from './ai/ai-credentials.js';
import { createSettingsAiPreferenceStore } from './ai/ai-preferences.js';
import { AiService } from './ai/ai-service.js';
import { GezelConnector } from './ai/gezel-connector.js';
import { defaultHostRuntimeEnvironment, resolveGezelHostRuntime } from './ai/gezel-host-runtime.js';
import { readSettings, updateSettings } from './settings.js';

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Whether this build offers AI at all. The Mac App Store sandbox cannot read
 * Gezel's per-user runtime directory, so discovery could never succeed there;
 * such a build omits the namespace instead of exposing one that always fails.
 */
export function isAiSupportedBuild(): boolean {
  return process.mas !== true;
}

export function createAiService(): AiService {
  const credentials = new EncryptedFileCredentialStore(
    path.join(app.getPath('userData'), 'ai', 'gezel-credential.bin'),
    safeStorage,
  );
  const hostEnvironment = defaultHostRuntimeEnvironment(app.isPackaged, process.resourcesPath);
  return new AiService({
    connector: new GezelConnector({
      credentials,
      hostRuntime: () => resolveGezelHostRuntime(hostEnvironment),
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
  const owners = new Map<number, Set<string>>();
  const watched = new WeakSet<WebContents>();

  service.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send('ai:status', status);
    }
  });

  const release = (ownerId: number) => {
    const ids = owners.get(ownerId);
    if (!ids) return;
    owners.delete(ownerId);
    for (const requestId of ids) service.cancelChat(streamKey(ownerId, requestId));
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
      let ids = owners.get(ownerId);
      if (!ids) {
        ids = new Set();
        owners.set(ownerId, ids);
      }
      if (ids.has(requestId)) throw new Error('Duplicate AI request id');
      ids.add(requestId);

      service.startChat(streamKey(ownerId, requestId), request, (chatEvent: AiChatEvent) => {
        if (chatEvent.kind !== 'delta') owners.get(ownerId)?.delete(requestId);
        if (!sender.isDestroyed()) sender.send('ai:chat:event', { requestId, event: chatEvent });
      });
    },
  );

  registerTrustedIpcHandler('ai:chat:cancel', 1, (event, requestIdValue: unknown): void => {
    const requestId = parseRequestId(requestIdValue);
    const ownerId = event.sender.id;
    if (owners.get(ownerId)?.has(requestId)) service.cancelChat(streamKey(ownerId, requestId));
  });
}
