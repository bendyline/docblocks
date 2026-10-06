/**
 * The preload half of `DocBlocksHostSpeechAPI`.
 *
 * Every value from main is re-parsed with the shared speech wire policy before
 * it reaches the renderer, and stream ids are minted here so a renderer can
 * never address another renderer's stream. `ipc` is injected so the bridge can
 * be tested without Electron.
 */

import {
  parseSpeechCatalog,
  parseSpeechInstallEvent,
  parseSpeechNullResult,
  parseSpeechPreferences,
  parseSpeechResult,
  parseSpeechStatus,
  parseSpeechSynthesizeEvent,
  parseSpeechTranscript,
} from '@bendyline/docblocks/host';
import type {
  DocBlocksHostSpeechAPI,
  SpeechError,
  SpeechModelInfo,
  SpeechResult,
  SpeechStatus,
  SpeechSynthesisSummary,
  SpeechSynthesizeEvent,
} from '@bendyline/docblocks/host';
import type { SpeechAvailability } from '../shared/host-environment.js';

type IpcListener = (event: unknown, payload: unknown) => void;

export interface SpeechIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

function failure(message: string, cause?: unknown): SpeechError {
  const detail = cause instanceof Error ? cause.message : undefined;
  return {
    code: 'unknown',
    message,
    ...(detail ? { detail: detail.replaceAll('\0', '').slice(0, 2_000) } : {}),
  };
}

const UNREADABLE = 'DocBlocks received a speech response it could not read.';

function unreadableStatus(): SpeechStatus {
  const readiness = { state: 'unavailable' as const, reason: UNREADABLE };
  return { stt: readiness, tts: readiness };
}

export function createSpeechApi(
  ipc: SpeechIpc,
  availability: SpeechAvailability,
  mintId: (prefix: string) => string,
): DocBlocksHostSpeechAPI {
  const api: DocBlocksHostSpeechAPI = {
    async status() {
      return parseSpeechStatus(await ipc.invoke('speech:status')) ?? unreadableStatus();
    },
    onStatus(listener) {
      const fn: IpcListener = (_event, payload) => {
        const status = parseSpeechStatus(payload);
        if (status) listener(status);
      };
      ipc.on('speech:status', fn);
      return () => {
        ipc.removeListener('speech:status', fn);
      };
    },
    async catalog() {
      return (
        parseSpeechResult(await ipc.invoke('speech:catalog'), parseSpeechCatalog) ?? {
          ok: false,
          error: failure(UNREADABLE),
        }
      );
    },
    async getPreferences() {
      const preferences = parseSpeechPreferences(await ipc.invoke('speech:getPreferences'));
      if (!preferences) throw new Error(UNREADABLE);
      return preferences;
    },
    async setPreferences(patch) {
      const preferences = parseSpeechPreferences(await ipc.invoke('speech:setPreferences', patch));
      if (!preferences) throw new Error(UNREADABLE);
      return preferences;
    },
    async prepare(kind) {
      try {
        return (
          parseSpeechNullResult(await ipc.invoke('speech:prepare', kind)) ?? {
            ok: false,
            error: failure(UNREADABLE),
          }
        );
      } catch (cause) {
        return { ok: false, error: failure('DocBlocks could not start the speech engine.', cause) };
      }
    },
    async removeModel(modelId) {
      try {
        return (
          parseSpeechNullResult(await ipc.invoke('speech:removeModel', modelId)) ?? {
            ok: false,
            error: failure(UNREADABLE),
          }
        );
      } catch (cause) {
        return { ok: false, error: failure('DocBlocks could not remove the model.', cause) };
      }
    },
    installModel(modelId, onProgress) {
      const requestId = mintId('speech-model');
      let finished = false;
      let settle: (result: SpeechResult<SpeechModelInfo>) => void = () => undefined;
      const done = new Promise<SpeechResult<SpeechModelInfo>>((resolve) => {
        settle = resolve;
      });
      const finish = (result: SpeechResult<SpeechModelInfo>) => {
        if (finished) return;
        finished = true;
        ipc.removeListener('speech:install:event', listener);
        settle(result);
      };
      const listener: IpcListener = (_event, payload) => {
        if (finished || typeof payload !== 'object' || payload === null) return;
        const record = payload as { requestId?: unknown; event?: unknown };
        if (record.requestId !== requestId) return;
        const event = parseSpeechInstallEvent(record.event);
        if (!event) {
          void ipc.invoke('speech:install:cancel', requestId).catch(() => undefined);
          finish({ ok: false, error: failure(UNREADABLE) });
          return;
        }
        if (event.kind === 'progress') {
          try {
            onProgress?.(event.progress);
          } catch {
            // A throwing consumer must not strand the download's bookkeeping.
          }
        } else if (event.kind === 'done') finish({ ok: true, value: event.model });
        else finish({ ok: false, error: event.error });
      };
      ipc.on('speech:install:event', listener);
      ipc.invoke('speech:install:start', requestId, modelId).catch((cause: unknown) => {
        finish({ ok: false, error: failure('DocBlocks could not start the download.', cause) });
      });
      return {
        done,
        cancel: () => {
          if (!finished) void ipc.invoke('speech:install:cancel', requestId).catch(() => undefined);
        },
      };
    },
  };

  if (availability.stt) {
    api.transcribe = async (request) => {
      try {
        return (
          parseSpeechResult(
            await ipc.invoke('speech:transcribe', request),
            parseSpeechTranscript,
          ) ?? {
            ok: false,
            error: failure(UNREADABLE),
          }
        );
      } catch (cause) {
        return { ok: false, error: failure('DocBlocks could not transcribe that audio.', cause) };
      }
    };
  }

  if (availability.tts) {
    api.synthesize = (request, onEvent) => {
      const requestId = mintId('speech-synth');
      let finished = false;
      let settle: (result: SpeechResult<SpeechSynthesisSummary>) => void = () => undefined;
      const done = new Promise<SpeechResult<SpeechSynthesisSummary>>((resolve) => {
        settle = resolve;
      });
      const deliver = (event: SpeechSynthesizeEvent) => {
        try {
          onEvent(event);
        } catch {
          // A throwing consumer must not strand the stream's bookkeeping.
        }
      };
      const finish = (result: SpeechResult<SpeechSynthesisSummary>) => {
        if (finished) return;
        finished = true;
        ipc.removeListener('speech:synthesize:event', listener);
        settle(result);
      };
      const listener: IpcListener = (_event, payload) => {
        if (finished || typeof payload !== 'object' || payload === null) return;
        const record = payload as { requestId?: unknown; event?: unknown };
        if (record.requestId !== requestId) return;
        const event = parseSpeechSynthesizeEvent(record.event);
        if (!event) {
          const error = failure(UNREADABLE);
          void ipc.invoke('speech:synthesize:cancel', requestId).catch(() => undefined);
          deliver({ kind: 'error', error });
          finish({ ok: false, error });
          return;
        }
        deliver(event);
        if (event.kind === 'done') finish({ ok: true, value: event.summary });
        else if (event.kind === 'error') finish({ ok: false, error: event.error });
      };
      // Listen before starting: main may answer before invoke resolves.
      ipc.on('speech:synthesize:event', listener);
      ipc.invoke('speech:synthesize:start', requestId, request).catch((cause: unknown) => {
        if (finished) return;
        const error = failure('DocBlocks could not start narration.', cause);
        deliver({ kind: 'error', error });
        finish({ ok: false, error });
      });
      return {
        done,
        cancel: () => {
          if (!finished) {
            void ipc.invoke('speech:synthesize:cancel', requestId).catch(() => undefined);
          }
        },
      };
    };
  }

  return api;
}
