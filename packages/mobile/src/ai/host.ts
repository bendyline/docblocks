import {
  parseAiChatRequest,
  parseAiPreferences,
  parseAiPreferencesPatch,
  type AiChatCompletion,
  type AiChatEvent,
  type AiModelInfo,
  type AiPreferences,
  type AiResult,
  type AiStatus,
  type DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import type { GezelRuntimePlugin } from '@bendyline/gezel-capacitor';
import type { GezelApp } from '@bendyline/gezel-app-sdk/browser';
import { catalog, downloads, inventory, modelChoices, providerLabel } from './models';
import { aiError, checkCancelled, failure, MobileAiError, notify } from './errors';
import { install } from './install';

export interface MobileAiSession {
  runtime: GezelRuntimePlugin;
  client: GezelApp<'portable'>;
}
export interface MobileAiOptions {
  load(): Promise<MobileAiSession>;
  readPreferences(): unknown;
  writePreferences(preferences: AiPreferences): void;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
  pollMs?: number;
}
const defaults: AiPreferences = { enabled: false, model: null, reviewMode: 'explicit' };
const provider = { name: 'Gezel', version: '0.1.0', mode: 'hosted' as const };

export function createMobileAi(options: MobileAiOptions): {
  ai: DocBlocksHostAiAPI;
  suspend(): void;
  resume(): void;
} {
  let preferences = parseAiPreferences(options.readPreferences()) ?? defaults;
  let status: AiStatus = {
    kind: 'unavailable',
    reason: preferences.enabled ? 'disconnected' : 'opt-out',
  };
  const listeners = new Set<(status: AiStatus) => void>();
  let generation = 0;
  let suspended = false;
  let session: MobileAiSession | undefined;
  let connecting: Promise<MobileAiSession> | undefined;
  let cleanup: Promise<void> = Promise.resolve();
  let choices: AiModelInfo[] = [];
  let chatController: AbortController | undefined;
  let installController: AbortController | undefined;
  const update = (next: AiStatus) => {
    status = next;
    for (const listener of listeners) notify(listener, next);
  };
  const ready = () => {
    if (preferences.enabled && !suspended && session)
      update({
        kind: 'ready',
        provider,
        model: choices.find((model) => model.isDefault) ?? null,
        activeRequests: chatController ? 1 : 0,
      });
  };
  const requireEnabled = () => {
    if (!preferences.enabled)
      throw new MobileAiError('inference-disabled', 'Turn on AI features in Settings first.');
    if (suspended) throw new MobileAiError('cancelled', 'AI runs while DocBlocks is open.');
  };
  async function refresh(current: MobileAiSession) {
    const snapshot = await inventory(current.runtime);
    if (session !== current || !preferences.enabled || suspended) return snapshot;
    choices = modelChoices(snapshot.providers, snapshot.models, preferences.model);
    ready();
    return snapshot;
  }
  function closeSession() {
    const previous = session;
    session = undefined;
    if (previous) {
      cleanup = previous.client.close().then(() => previous.runtime.releaseModel());
      // Retain the rejection for the next start, while background cleanup has no caller.
      void cleanup.catch(() => {});
    }
  }
  async function getSession(): Promise<MobileAiSession> {
    requireEnabled();
    if (session) return session;
    if (connecting) return connecting;
    const scope = generation;
    update({
      kind: 'connecting',
      step: 'preparing-model',
      verificationCode: null,
      progress: { phase: 'runtime', message: 'Checking on-device models…', percent: null },
    });
    const pending = (async () => {
      const previousCleanup = cleanup;
      cleanup = Promise.resolve();
      await previousCleanup;
      requireEnabled();
      if (scope !== generation) throw new MobileAiError('cancelled', 'AI settings changed.');
      const loaded = await options.load();
      if (scope !== generation || !preferences.enabled || suspended) {
        await loaded.client.close();
        throw new MobileAiError('cancelled', 'AI was switched off.');
      }
      session = loaded;
      await refresh(loaded);
      requireEnabled();
      if (scope !== generation) throw new MobileAiError('cancelled', 'AI settings changed.');
      return loaded;
    })();
    connecting = pending;
    try {
      return await pending;
    } catch (error) {
      if (scope === generation && preferences.enabled && !suspended) {
        closeSession();
        update({ kind: 'error', error: aiError(error), retryable: true });
      }
      throw error;
    } finally {
      if (connecting === pending) connecting = undefined;
    }
  }
  function stop() {
    generation++;
    chatController?.abort();
    installController?.abort();
    closeSession();
    connecting = undefined;
    choices = [];
  }
  async function start(): Promise<AiResult<AiStatus>> {
    try {
      await getSession();
      return { ok: true, value: status };
    } catch (error) {
      return failure(error);
    }
  }
  const ai: DocBlocksHostAiAPI = {
    // All models belong to this app. There is no separate companion to connect.
    providerInstalled: async () => false,
    status: async () => {
      if (preferences.enabled && !suspended && !session) await start();
      return status;
    },
    onStatus: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getPreferences: async () => ({ ...preferences }),
    async setPreferences(raw) {
      const patch = parseAiPreferencesPatch(raw);
      if (!patch) throw new TypeError('Invalid AI preferences.');
      const next = { ...preferences, ...patch };
      options.writePreferences(next);
      preferences = next;
      if (!next.enabled) {
        stop();
        update({ kind: 'unavailable', reason: 'opt-out' });
      } else {
        try {
          const current = await getSession();
          await refresh(current);
        } catch (error) {
          if (!suspended && preferences.enabled)
            update({ kind: 'error', error: aiError(error), retryable: true });
        }
      }
      return { ...preferences };
    },
    connect: start,
    disconnect: async () => {
      stop();
      if (preferences.enabled) await start();
      return { ok: true, value: null };
    },
    async models() {
      try {
        const current = await getSession();
        await refresh(current);
        requireEnabled();
        return { ok: true, value: choices };
      } catch (error) {
        return failure(error);
      }
    },
    async availableModels() {
      try {
        const current = await getSession();
        const snapshot = await refresh(current);
        const pending = await downloads(current.runtime);
        requireEnabled();
        const llama = snapshot.providers.find((entry) => entry.id === 'llama-cpp');
        const memory = snapshot.models.memoryBudgetBytes;
        const available =
          llama !== undefined
            ? catalog
                .filter(
                  (model) =>
                    !snapshot.models.models.some(
                      (installed) => installed.source?.sha256 === model.source.sha256,
                    ) &&
                    (memory === undefined || model.approxSizeBytes + 512 * 1024 ** 2 <= memory),
                )
                .map((model) => ({
                  id: model.id,
                  label: model.name,
                  contextWindow: Math.min(llama.contextTokens, 4096),
                  downloadBytes: model.approxSizeBytes,
                  state: pending.some(
                    (entry) =>
                      entry.source.sha256 === model.source.sha256 &&
                      ['queued', 'downloading', 'verifying'].includes(entry.state),
                  )
                    ? ('downloading' as const)
                    : ('download-required' as const),
                }))
            : [];
        const system = snapshot.providers.find(
          (entry) =>
            entry.id === 'android-mlkit' &&
            ['download-required', 'downloading'].includes(entry.availability),
        );
        return {
          ok: true,
          value: [
            ...(system
              ? [
                  {
                    id: 'provider:android-mlkit',
                    label: providerLabel(system),
                    contextWindow: Math.min(system.contextTokens, 4096),
                    downloadBytes: null,
                    state:
                      system.availability === 'downloading'
                        ? ('downloading' as const)
                        : ('download-required' as const),
                  },
                ]
              : []),
            ...available,
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
    installModel(id, onProgress) {
      const controller = new AbortController();
      const done = (async (): Promise<AiResult<AiModelInfo>> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        if (installController || chatController)
          return failure(
            new MobileAiError('rate-limited', 'Finish the current AI operation first.'),
          );
        installController = controller;
        try {
          const current = await getSession();
          checkCancelled(controller.signal);
          timeout = setTimeout(() => controller.abort(), options.downloadTimeoutMs ?? 30 * 60_000);
          const installed = await install(
            current.runtime,
            id,
            controller.signal,
            onProgress,
            options.pollMs,
          );
          checkCancelled(controller.signal);
          await refresh(current);
          const model = choices.find((entry) => entry.id === installed);
          if (!model)
            throw new MobileAiError(
              'model-unavailable',
              'The installed model is not ready on this device.',
            );
          return { ok: true, value: model };
        } catch (error) {
          return failure(
            controller.signal.aborted
              ? new MobileAiError('cancelled', 'The model download was cancelled or paused.')
              : error,
          );
        } finally {
          clearTimeout(timeout);
          if (installController === controller) installController = undefined;
          ready();
        }
      })();
      return { done, cancel: () => controller.abort() };
    },
    chat(raw, onEvent) {
      const controller = new AbortController();
      let text = '';
      let modelId = '';
      let timedOut = false;
      const emit = (event: AiChatEvent) => notify(onEvent, event);
      const completion = (finishReason: AiChatCompletion['finishReason']): AiChatCompletion => ({
        text,
        model: modelId,
        finishReason,
        usage: null,
      });
      const done = (async (): Promise<AiResult<AiChatCompletion>> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          if (chatController || installController)
            throw new MobileAiError('rate-limited', 'Finish the current AI operation first.');
          chatController = controller;
          const request = parseAiChatRequest(raw);
          if (!request)
            throw new MobileAiError('budget-exceeded', 'This AI request is invalid or too large.');
          const current = await getSession();
          checkCancelled(controller.signal);
          const snapshot = await refresh(current);
          modelId =
            request.model ??
            preferences.model ??
            choices.find((model) => model.isDefault)?.id ??
            '';
          const model = choices.find((entry) => entry.id === modelId);
          const nativeProvider = snapshot.providers.find((entry) =>
            modelId.startsWith(`${entry.id}:`),
          );
          if (!model || !nativeProvider)
            throw new MobileAiError(
              'model-unavailable',
              'Choose an available on-device model in Settings → AI assistance.',
            );
          if (nativeProvider.availability !== 'available')
            throw new MobileAiError(
              'model-unavailable',
              model.unavailableReason ?? 'The selected model is not ready on this device.',
            );
          checkCancelled(controller.signal);
          ready();
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, options.requestTimeoutMs ?? 180_000);
          const maxTokens = Math.min(
            request.maxTokens ?? 512,
            nativeProvider.maxOutputTokens,
            Math.floor((model.contextWindow ?? 4096) / 2),
            2048,
          );
          // Portable App SDK supports provider-default sampling only. Do not send
          // the desktop temperature hint as an unsupported native request field.
          const stream = await current.client.chat(
            {
              model: modelId,
              messages: [...request.messages],
              stream: true,
              max_tokens: maxTokens,
            },
            { signal: controller.signal },
          );
          let finishReason: AiChatCompletion['finishReason'] = 'stop';
          for await (const chunk of stream) {
            if (controller.signal.aborted) break;
            const choice = chunk.choices[0];
            const delta = choice?.delta.content;
            if (typeof delta === 'string' && delta) {
              if (text.length + delta.length > 256_000)
                throw new MobileAiError(
                  'budget-exceeded',
                  'The AI response exceeded its size limit.',
                );
              text += delta;
              emit({ kind: 'delta', text: delta });
            }
            if (choice?.finish_reason === 'length') finishReason = 'length';
            if (choice?.finish_reason === 'cancelled') finishReason = 'cancelled';
          }
          if (timedOut)
            throw new MobileAiError(
              'timeout',
              'The on-device model took too long. Try a shorter selection or a smaller model.',
            );
          if (!text.trim() && !controller.signal.aborted && finishReason !== 'cancelled')
            throw new MobileAiError(
              finishReason === 'length' ? 'budget-exceeded' : 'provider-unavailable',
              'The model did not produce an answer. Try a shorter prompt or a different model.',
            );
          const value = completion(controller.signal.aborted ? 'cancelled' : finishReason);
          emit({ kind: 'done', completion: value });
          return { ok: true, value };
        } catch (error) {
          if (controller.signal.aborted && !timedOut) {
            const value = completion('cancelled');
            emit({ kind: 'done', completion: value });
            return { ok: true, value };
          }
          const problem = timedOut
            ? aiError(
                new MobileAiError(
                  'timeout',
                  'The on-device model took too long. Try a shorter selection or a smaller model.',
                ),
              )
            : aiError(error);
          emit({ kind: 'error', error: problem });
          return { ok: false, error: problem };
        } finally {
          controller.abort();
          clearTimeout(timeout);
          if (chatController === controller) chatController = undefined;
          ready();
        }
      })();
      return { done, cancel: () => controller.abort() };
    },
  };
  return {
    ai,
    suspend() {
      suspended = true;
      stop();
      update({ kind: 'unavailable', reason: preferences.enabled ? 'disconnected' : 'opt-out' });
    },
    resume() {
      suspended = false;
      if (preferences.enabled) void start();
    },
  };
}
