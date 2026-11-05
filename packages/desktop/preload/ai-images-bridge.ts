/**
 * The preload half of `DocBlocksHostAiAPI.images`.
 *
 * Every value from main is re-parsed with the shared image wire policy before
 * it reaches the renderer, including the PNG bytes of a finished render, and
 * stream ids are minted here so a renderer can never address another
 * renderer's render or download. `ipc` is injected so the bridge can be
 * tested without Electron.
 */

import {
  isAiImageModelId,
  parseAiError,
  parseAiImageAccess,
  parseAiImageEvent,
  parseAiImageInstallEvent,
  parseAiImageModelList,
  parseAiImageModel,
  parseAiImageStyle,
  parseAiImageStyleList,
  parseAiImagePreferences,
  parseAiImagePreferencesPatch,
  parseAiImageRequest,
} from '@bendyline/docblocks/host';
import type {
  AiError,
  AiImageAccess,
  AiImageEvent,
  AiImageInstallHandle,
  AiProgress,
  AiImageResult,
  AiImagesAPI,
  AiResult,
} from '@bendyline/docblocks/host';

type IpcListener = (event: unknown, payload: unknown) => void;

export interface AiImagesIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

function failure(message: string, cause?: unknown): AiError {
  const detail = cause instanceof Error ? cause.message : undefined;
  return {
    code: 'unknown',
    message,
    ...(detail ? { detail: detail.replaceAll('\0', '').slice(0, 2_000) } : {}),
  };
}

const UNREADABLE = 'DocBlocks received an image response it could not read.';

/** An exact `{ok, value}` / `{ok, error}` envelope, or a failure that says it was unreadable. */
function result<T>(value: unknown, parse: (value: unknown) => T | null): AiResult<T> {
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 2) {
    const envelope = value as { ok?: unknown; value?: unknown; error?: unknown };
    if (envelope.ok === true && Object.hasOwn(value, 'value')) {
      const parsed = parse(envelope.value);
      if (parsed !== null) return { ok: true, value: parsed };
    }
    if (envelope.ok === false && Object.hasOwn(value, 'error')) {
      const error = parseAiError(envelope.error);
      if (error) return { ok: false, error };
    }
  }
  return { ok: false, error: failure(UNREADABLE) };
}

function streamPayload(payload: unknown, requestId: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as { requestId?: unknown; event?: unknown };
  return record.requestId === requestId ? (record.event ?? null) : undefined;
}

export function createAiImagesApi(
  ipc: AiImagesIpc,
  mintId: (prefix: string) => string,
): AiImagesAPI {
  function install<T>(
    id: string,
    onProgress: ((progress: AiProgress) => void) | undefined,
    parse: (value: unknown) => T | null,
    channel: string,
  ): AiImageInstallHandle<T> {
    const requestId = mintId(channel === 'install' ? 'ai-image-model' : 'ai-image-style');
    let finished = false;
    let settle: (value: AiResult<T>) => void = () => undefined;
    const done = new Promise<AiResult<T>>((resolve) => {
      settle = resolve;
    });
    const finish = (value: AiResult<T>) => {
      if (finished) return;
      finished = true;
      ipc.removeListener(`ai:images:${channel}:event`, listener);
      settle(value);
    };
    const listener: IpcListener = (_event, payload) => {
      if (finished) return;
      const raw = streamPayload(payload, requestId);
      if (raw === undefined) return;
      const event = parseAiImageInstallEvent(raw, parse);
      if (!event) {
        void ipc.invoke(`ai:images:${channel}:cancel`, requestId).catch(() => undefined);
        finish({ ok: false, error: failure(UNREADABLE) });
        return;
      }
      if (event.kind === 'progress') onProgress?.(event.progress);
      else if (event.kind === 'done') finish({ ok: true, value: event.model });
      else finish({ ok: false, error: event.error });
    };
    if (!isAiImageModelId(id)) {
      finish({ ok: false, error: failure('Invalid image model.') });
    } else {
      ipc.on(`ai:images:${channel}:event`, listener);
      ipc.invoke(`ai:images:${channel}:start`, requestId, id).catch((cause: unknown) => {
        finish({ ok: false, error: failure('DocBlocks could not start the download.', cause) });
      });
    }
    return {
      done,
      cancel: () => {
        if (!finished) {
          void ipc.invoke(`ai:images:${channel}:cancel`, requestId).catch(() => undefined);
        }
      },
    };
  }

  const unavailable: AiImageAccess = {
    kind: 'unavailable',
    reason: 'not-connected',
    message: UNREADABLE,
  };
  return {
    async access() {
      return parseAiImageAccess(await ipc.invoke('ai:images:access')) ?? unavailable;
    },
    onAccess(listener) {
      const fn: IpcListener = (_event, payload) => {
        const access = parseAiImageAccess(payload);
        if (access) listener(access);
      };
      ipc.on('ai:images:access', fn);
      return () => {
        ipc.removeListener('ai:images:access', fn);
      };
    },
    async requestAccess() {
      return result(await ipc.invoke('ai:images:requestAccess'), parseAiImageAccess);
    },
    async models() {
      return result(await ipc.invoke('ai:images:models'), parseAiImageModelList);
    },
    async styles() {
      return result(await ipc.invoke('ai:images:styles'), parseAiImageStyleList);
    },
    async removeStyle(id) {
      if (!isAiImageModelId(id)) return { ok: false, error: failure('Invalid image style.') };
      const removed = result(await ipc.invoke('ai:images:removeStyle', id), (value) =>
        value === null ? true : null,
      );
      return removed.ok ? { ok: true, value: null } : removed;
    },
    async removeModel(id) {
      if (!isAiImageModelId(id)) return { ok: false, error: failure('Invalid image model.') };
      const removed = result(await ipc.invoke('ai:images:remove', id), (value) =>
        value === null ? true : null,
      );
      return removed.ok ? { ok: true, value: null } : removed;
    },
    async getPreferences() {
      const preferences = parseAiImagePreferences(await ipc.invoke('ai:images:getPreferences'));
      if (!preferences) throw new Error(UNREADABLE);
      return preferences;
    },
    async setPreferences(value) {
      const patch = parseAiImagePreferencesPatch(value);
      if (!patch) throw new Error('Invalid image preferences.');
      const preferences = parseAiImagePreferences(
        await ipc.invoke('ai:images:setPreferences', patch),
      );
      if (!preferences) throw new Error(UNREADABLE);
      return preferences;
    },
    installModel: (id, onProgress) => install(id, onProgress, parseAiImageModel, 'install'),
    installStyle: (id, onProgress) => install(id, onProgress, parseAiImageStyle, 'install-style'),
    generate(value, onEvent) {
      const requestId = mintId('ai-image');
      let finished = false;
      let settle: (value: AiResult<AiImageResult>) => void = () => undefined;
      const done = new Promise<AiResult<AiImageResult>>((resolve) => {
        settle = resolve;
      });
      const deliver = (event: AiImageEvent) => {
        try {
          onEvent(event);
        } catch {
          /* a listener cannot break the stream */
        }
      };
      const finish = (outcome: AiResult<AiImageResult>) => {
        if (finished) return;
        finished = true;
        ipc.removeListener('ai:images:generate:event', listener);
        deliver(
          outcome.ok
            ? { kind: 'done', image: outcome.value }
            : { kind: 'error', error: outcome.error },
        );
        settle(outcome);
      };
      const listener: IpcListener = (_event, payload) => {
        if (finished) return;
        const raw = streamPayload(payload, requestId);
        if (raw === undefined) return;
        const event = parseAiImageEvent(raw);
        if (!event) {
          void ipc.invoke('ai:images:generate:cancel', requestId).catch(() => undefined);
          finish({ ok: false, error: failure(UNREADABLE) });
          return;
        }
        if (event.kind === 'progress') deliver(event);
        else if (event.kind === 'done') finish({ ok: true, value: event.image });
        else finish({ ok: false, error: event.error });
      };
      const request = parseAiImageRequest(value);
      if (!request) {
        finish({ ok: false, error: failure('That image request is not valid.') });
      } else {
        ipc.on('ai:images:generate:event', listener);
        ipc.invoke('ai:images:generate:start', requestId, request).catch((cause: unknown) => {
          finish({ ok: false, error: failure('DocBlocks could not start the image.', cause) });
        });
      }
      return {
        done,
        cancel: () => {
          if (!finished) {
            void ipc.invoke('ai:images:generate:cancel', requestId).catch(() => undefined);
          }
        },
      };
    },
  };
}
