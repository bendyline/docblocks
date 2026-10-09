import {
  AI_WIRE_LIMITS,
  parseAiChatProgress,
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
import {
  createEmbedding,
  type EmbeddingConnection,
  type ModelDescriptor,
} from '@bendyline/gezel-app-sdk/browser';
import { modelChoices } from './models';
import { aiError, checkCancelled, failure, MobileAiError, notify } from './errors';

export interface MobileAiOptions {
  load(): Promise<EmbeddingConnection>;
  readPreferences(): unknown;
  writePreferences(preferences: AiPreferences): void;
  requestTimeoutMs?: number;
}
const defaults: AiPreferences = { enabled: false, model: null, reviewMode: 'explicit' };
const provider = { name: 'Gezel', version: '0.1.0', mode: 'hosted' as const };

export function createMobileAi(options: MobileAiOptions) {
  let preferences = parseAiPreferences(options.readPreferences()) ?? defaults;
  let status: AiStatus = {
    kind: 'unavailable',
    reason: preferences.enabled ? 'disconnected' : 'opt-out',
  };
  const listeners = new Set<(status: AiStatus) => void>();
  let descriptors: ModelDescriptor[] = [];
  let choices: AiModelInfo[] = [];
  let suspended = false;
  let operation: AbortController | undefined;
  const update = (next: AiStatus) => {
    status = next;
    for (const listener of listeners) notify(listener, next);
  };
  const embedding = createEmbedding({
    connect: options.load,
    onState: (state) => {
      if (state === 'connecting')
        update({
          kind: 'connecting',
          step: 'preparing-model',
          verificationCode: null,
          progress: { phase: 'runtime', message: 'Checking on-device models…', percent: null },
        });
    },
  });
  // Gezel starts disabled; setting saved opt-in performs no native work.
  void embedding.setEnabled(preferences.enabled);
  const ready = () => {
    if (preferences.enabled && !suspended && embedding.state === 'ready')
      update({
        kind: 'ready',
        provider,
        model: choices.find((model) => model.isDefault) ?? null,
        activeRequests: operation ? 1 : 0,
      });
  };
  async function refresh() {
    const models = await embedding.models.list();
    descriptors = models;
    choices = modelChoices(models, preferences.model);
    ready();
    return models;
  }
  async function start(): Promise<AiResult<AiStatus>> {
    try {
      await refresh();
      return { ok: true, value: status };
    } catch (error) {
      if (preferences.enabled && !suspended)
        update({ kind: 'error', error: aiError(error), retryable: true });
      return failure(error);
    }
  }
  const reserve = (controller: AbortController) => {
    if (operation)
      throw new MobileAiError('rate-limited', 'Finish the current AI operation first.');
    operation = controller;
  };
  const release = (controller: AbortController) => {
    if (operation === controller) operation = undefined;
    ready();
  };
  const ai: DocBlocksHostAiAPI = {
    providerInstalled: async () => false,
    status: async () => {
      if (preferences.enabled && !suspended && embedding.state !== 'ready') await start();
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
        operation?.abort();
        choices = [];
        descriptors = [];
        update({ kind: 'unavailable', reason: 'opt-out' });
      }
      await embedding.setEnabled(next.enabled);
      if (next.enabled && !suspended) await start();
      return { ...preferences };
    },
    connect: start,
    disconnect: async () => {
      try {
        operation?.abort();
        await embedding.setEnabled(false);
        await embedding.setEnabled(preferences.enabled);
        if (preferences.enabled && !suspended) await start();
        return { ok: true, value: null };
      } catch (error) {
        return failure(error);
      }
    },
    async models() {
      try {
        await refresh();
        return { ok: true, value: choices };
      } catch (error) {
        return failure(error);
      }
    },
    async availableModels() {
      try {
        const models = await refresh();
        return {
          ok: true,
          value: models.flatMap((model) =>
            model.availability === 'download-required' || model.availability === 'downloading'
              ? [
                  {
                    id: model.id,
                    label: model.name,
                    contextWindow: model.context_window ?? null,
                    downloadBytes: model.download_bytes ?? null,
                    state: model.availability,
                  },
                ]
              : [],
          ),
        };
      } catch (error) {
        return failure(error);
      }
    },
    installModel(id, onProgress) {
      const controller = new AbortController();
      const done = (async (): Promise<AiResult<AiModelInfo>> => {
        try {
          reserve(controller);
          const installed = await embedding.models.prepare(id, {
            allowDownload: true,
            signal: controller.signal,
            onProgress: (event) =>
              notify(onProgress, {
                phase: event.phase,
                message: event.message,
                percent:
                  event.percent ??
                  (event.totalBytes && event.bytesWritten !== undefined
                    ? (100 * event.bytesWritten) / event.totalBytes
                    : null),
              }),
          });
          await refresh();
          checkCancelled(controller.signal);
          const model = choices.find((entry) => entry.id === installed.id);
          if (!model)
            throw new MobileAiError(
              'model-unavailable',
              'The installed model is not ready on this device.',
            );
          return { ok: true, value: model };
        } catch (error) {
          return failure(error);
        } finally {
          release(controller);
        }
      })();
      return { done, cancel: () => controller.abort() };
    },
    chat(raw, onEvent) {
      const controller = new AbortController();
      let text = '',
        modelId = '';
      let timedOut = false;
      const emit = (event: AiChatEvent) => notify(onEvent, event);
      const cancelled = (): AiChatCompletion => ({
        text,
        model: modelId,
        finishReason: 'cancelled',
        usage: null,
      });
      const done = (async (): Promise<AiResult<AiChatCompletion>> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          reserve(controller);
          const request = parseAiChatRequest(raw);
          if (!request)
            throw new MobileAiError('budget-exceeded', 'This AI request is invalid or too large.');
          await refresh();
          checkCancelled(controller.signal);
          modelId =
            request.model ??
            preferences.model ??
            choices.find((model) => model.isDefault)?.id ??
            '';
          const model = descriptors.find(
            (entry) => entry.id === modelId || entry.aliases?.includes(modelId),
          );
          if (!model || model.availability !== 'available')
            throw new MobileAiError(
              'model-unavailable',
              model?.unavailable_reason ??
                'Choose an available on-device model in Settings → AI assistance.',
            );
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, options.requestTimeoutMs ?? 180_000);
          const result = await embedding.streamText(
            {
              model: model.id,
              messages: [...request.messages],
              maxTokens: Math.min(
                request.maxTokens ??
                  (request.purpose === 'write'
                    ? (model.default_output_tokens ?? model.max_output_tokens ?? 2048)
                    : 512),
                model.max_output_tokens ?? 2048,
                Math.max(1, (model.context_window ?? 4096) - 1),
              ),
              // Sampling support comes from inventory, never a host/provider-name test.
              ...(model.supported_options?.includes('temperature') &&
              request.temperature !== undefined
                ? { temperature: request.temperature }
                : {}),
              // Native replies are capped at 4K tokens; leave that budget for
              // the editor's answer instead of an invisible thinking phase.
              ...(model.supported_options?.includes('reasoning_effort')
                ? { reasoningEffort: 'none' }
                : {}),
            },
            {
              signal: controller.signal,
              maxCharacters: Math.min(AI_WIRE_LIMITS.completionCharacters, 4 * 1024 * 1024),
              onEvent: (event) => {
                if (event.type === 'delta') {
                  text += event.text;
                  emit({ kind: 'delta', text: event.text });
                }
                if (event.type === 'progress') {
                  const progress = parseAiChatProgress(event.progress);
                  if (progress) emit({ kind: 'progress', progress });
                }
              },
            },
          );
          if (timedOut)
            throw new MobileAiError(
              'timeout',
              'The on-device model took too long. Try a shorter selection or a smaller model.',
            );
          if (!result.text.trim() && !result.cancelled)
            throw new MobileAiError(
              result.finishReason === 'length' ? 'budget-exceeded' : 'provider-unavailable',
              'The model did not produce an answer. Try a shorter prompt or a different model.',
            );
          const value: AiChatCompletion = {
            text: result.text,
            model: result.model,
            finishReason: result.cancelled
              ? 'cancelled'
              : result.finishReason === 'length'
                ? 'length'
                : 'stop',
            usage: result.usage
              ? {
                  promptTokens: result.usage.prompt_tokens,
                  completionTokens: result.usage.completion_tokens,
                }
              : null,
          };
          emit({ kind: 'done', completion: value });
          return { ok: true, value };
        } catch (error) {
          if (controller.signal.aborted && !timedOut) {
            const value = cancelled();
            emit({ kind: 'done', completion: value });
            return { ok: true, value };
          }
          const problem = aiError(error);
          emit({ kind: 'error', error: problem });
          return { ok: false, error: problem };
        } finally {
          clearTimeout(timeout);
          release(controller);
        }
      })();
      return { done, cancel: () => controller.abort() };
    },
  };
  return {
    ai,
    suspend() {
      suspended = true;
      operation?.abort();
      update({ kind: 'unavailable', reason: preferences.enabled ? 'disconnected' : 'opt-out' });
      void embedding
        .suspend()
        .catch((error) => update({ kind: 'error', error: aiError(error), retryable: true }));
    },
    resume() {
      suspended = false;
      embedding.resume();
      if (preferences.enabled) void start();
    },
  };
}
