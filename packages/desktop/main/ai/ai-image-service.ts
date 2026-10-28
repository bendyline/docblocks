/**
 * The main-process side of `DocBlocksHostAiAPI.images`.
 *
 * It rides on the AI connection `AiService` owns, but never on its failure
 * path: a missing images grant, an engine that cannot render here or a full
 * graphics card is an image problem, and must never tear down the connection
 * chat is using. Like the chat side it knows nothing about Electron.
 *
 * Renders stream phased progress and end exactly once. Cancelling one stops
 * the provider's engine (a running render cannot be interrupted any other
 * way), and downloads cancel at the provider so they stop using disk.
 */

import type {
  AiError,
  AiImageAccess,
  AiImageEvent,
  AiImageInstallEvent,
  AiImageModel,
  AiImagePhase,
  AiImagePreferences,
  AiImagePreferencesPatch,
  AiImageRequest,
  AiProgress,
  AiResult,
  AiStatus,
} from '@bendyline/docblocks/host';
import { AI_IMAGE_FIT_VERDICTS, HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';
import { AiHostError, aiError, toAiError } from './ai-errors.js';

/** What the provider's image surface reports about this app. */
export type ProviderImageAccess = 'granted' | 'needs-approval' | 'no-engine' | 'unsupported';

/** One image model as the provider lists it. */
export interface ProviderImageModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly availability: 'available' | 'download-required' | 'downloading';
  readonly shared?: boolean;
  readonly download_bytes?: number;
  readonly license?: string;
  readonly commercial_use?: boolean;
  readonly renders_text?: boolean;
  readonly prompt_style?: string;
  readonly hardware_tier?: string;
  readonly min_ram_gb?: number;
  readonly fit?: { readonly verdict: string; readonly reason: string };
}

export type ProviderEnsureEvent =
  | { readonly type: 'progress'; readonly bytesWritten: number; readonly totalBytes: number }
  | {
      readonly type: 'retrying';
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly reason: string;
    }
  | { readonly type: 'verifying' | 'extracting-metadata' }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly error: string };

export interface ProviderImageProgress {
  readonly phase: 'queued' | 'loading_model' | 'sampling' | 'decoding';
  readonly step: number;
  readonly totalSteps: number;
  readonly secondsPerStep?: number;
}

export interface ProviderImage {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly model: string;
  readonly durationMs: number;
}

/** The provider's image surface, as the connector adapts it. */
export interface ProviderImages {
  access(signal: AbortSignal): Promise<ProviderImageAccess>;
  requestAccess(onVerificationCode: (code: string) => void): Promise<void>;
  models(signal: AbortSignal): Promise<readonly ProviderImageModel[]>;
  ensure(
    id: string,
    signal: AbortSignal,
  ): Promise<
    { readonly status: 'ready' } | { readonly status: 'downloading'; readonly jobId: string }
  >;
  ensureEvents(jobId: string, signal: AbortSignal): AsyncIterable<ProviderEnsureEvent>;
  cancelEnsure(jobId: string): Promise<void>;
  remove(id: string, signal: AbortSignal): Promise<void>;
  generate(
    input: {
      prompt: string;
      negativePrompt?: string;
      model?: string;
      aspectRatio?: string;
      seed?: number;
    },
    options: { signal: AbortSignal; onProgress(progress: ProviderImageProgress): void },
  ): Promise<ProviderImage>;
}

export interface ImagePreferenceStoreLike {
  get(): Promise<AiImagePreferences>;
  set(patch: AiImagePreferencesPatch): Promise<AiImagePreferences>;
}

export interface AiImageServiceOptions {
  /** The current connection's image surface, or null when AI is not ready. */
  readonly images: () => ProviderImages | null;
  readonly status: () => Promise<AiStatus>;
  readonly onStatus: (listener: (status: AiStatus) => void) => () => void;
  readonly preferences: ImagePreferenceStoreLike;
  /**
   * Why this computer or build cannot render at all, checked before asking
   * the provider: a missing graphics driver piece, or a build without the
   * engine. Null when nothing is known to prevent it.
   */
  readonly blocked?: () => Extract<AiImageAccess, { kind: 'unavailable' }> | null;
  /** Renders in flight across every window: one rendering, one waiting. */
  readonly maxRenders?: number;
}

export type AiImageEmitter = (event: AiImageEvent) => void;
export type AiImageInstallEmitter = (event: AiImageInstallEvent) => void;

const DEFAULT_MAX_RENDERS = 2;
const MAX_INSTALLS = 2;
const LOOKUP_TIMEOUT_MS = 30_000;

const NOT_CONNECTED: Extract<AiImageAccess, { kind: 'unavailable' }> = {
  kind: 'unavailable',
  reason: 'not-connected',
  message: 'Turn on AI in Settings to generate images.',
};
const NO_ENGINE: Extract<AiImageAccess, { kind: 'unavailable' }> = {
  kind: 'unavailable',
  reason: 'no-engine',
  message: 'Gezel cannot generate images on this computer.',
};

/** Image failures say what to do about images; the provider's text goes to detail. */
const IMAGE_ERRORS: ReadonlyMap<string, [AiError['code'], string]> = new Map([
  [
    'image_capacity',
    [
      'model-unavailable',
      'There is not enough free graphics memory to render this image. Close other apps or AI models, or choose a smaller image model.',
    ],
  ],
  [
    'capacity_denied',
    [
      'model-unavailable',
      'This computer does not have enough free memory for this image model. Choose a smaller one in Settings.',
    ],
  ],
  [
    'no_local_image_model',
    ['model-unavailable', 'No image model is installed yet. Download one in Settings.'],
  ],
  [
    'model_not_installed',
    ['model-unavailable', 'That image model is not installed. Download it in Settings.'],
  ],
  ['unknown_model', ['model-unavailable', 'Gezel does not offer that image model.']],
  ['model_wont_run', ['model-unavailable', 'That image model is too large for this computer.']],
  [
    'missing_scope:images',
    ['approval-required', 'DocBlocks needs permission to generate images. Allow it in Settings.'],
  ],
  [
    'images_unavailable',
    ['unsupported', 'This version of Gezel cannot generate images. Update Gezel, then try again.'],
  ],
  [
    'images_unsupported',
    ['unsupported', 'This version of Gezel cannot generate images. Update Gezel, then try again.'],
  ],
  [
    'scope_upgrade_unsupported',
    [
      'unsupported',
      'This version of Gezel cannot add image generation to a connected app. Update Gezel, then try again.',
    ],
  ],
  [
    'shared_model',
    ['unsupported', 'This model belongs to your Gezel app. Remove it from Gezel instead.'],
  ],
  ['cancelled', ['cancelled', 'The image was cancelled.']],
]);

export function imageError(error: unknown): AiError {
  if (error instanceof AiHostError) return toAiError(error);
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const mapped = typeof code === 'string' ? IMAGE_ERRORS.get(code) : undefined;
  if (mapped) {
    return aiError(mapped[0], mapped[1], error instanceof Error ? error.message : undefined);
  }
  return toAiError(error);
}

function clip(text: string, limit: number): string {
  const clean = text.replaceAll('\0', '');
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

const HARDWARE_TIERS = new Set(['low', 'mid', 'high', 'workstation']);

export function toAiImageModel(model: ProviderImageModel): AiImageModel {
  const label = HOST_WIRE_LIMITS.labelCharacters;
  const message = HOST_WIRE_LIMITS.messageCharacters;
  const bytes = model.download_bytes;
  const fit = model.fit;
  return {
    id: model.id,
    label: clip(model.name, label) || model.id,
    description: model.description ? clip(model.description, message) : null,
    state:
      model.availability === 'available'
        ? 'installed'
        : model.availability === 'downloading'
          ? 'downloading'
          : 'download-required',
    downloadBytes:
      typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
    shared: model.shared === true,
    license: model.license ? clip(model.license, label) : null,
    commercialUse: typeof model.commercial_use === 'boolean' ? model.commercial_use : null,
    rendersText: model.renders_text === true,
    promptStyle:
      model.prompt_style === 'sentences' || model.prompt_style === 'tags'
        ? model.prompt_style
        : null,
    hardwareTier:
      model.hardware_tier && HARDWARE_TIERS.has(model.hardware_tier)
        ? (model.hardware_tier as AiImageModel['hardwareTier'])
        : null,
    minRamGb:
      typeof model.min_ram_gb === 'number' && Number.isFinite(model.min_ram_gb)
        ? Math.max(0, Math.round(model.min_ram_gb))
        : null,
    fit:
      fit && (AI_IMAGE_FIT_VERDICTS as readonly string[]).includes(fit.verdict)
        ? {
            verdict: fit.verdict as NonNullable<AiImageModel['fit']>['verdict'],
            reason: clip(fit.reason, message),
          }
        : null,
  };
}

const PHASES: Record<ProviderImageProgress['phase'], AiImagePhase> = {
  queued: 'queued',
  loading_model: 'loading-model',
  sampling: 'sampling',
  decoding: 'decoding',
};

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function timeoutSignal(controller: AbortController, ms: number): () => void {
  const timer = setTimeout(
    () => controller.abort(new AiHostError('timeout', 'Gezel did not answer in time.')),
    ms,
  );
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class AiImageService {
  private readonly options: AiImageServiceOptions;
  private readonly maxRenders: number;
  private readonly renders = new Map<string, AbortController>();
  private readonly installs = new Map<string, AbortController>();
  private readonly listeners = new Set<(access: AiImageAccess) => void>();
  private lastAccess: AiImageAccess | null = null;
  /** The approval code while a request for image access waits for the person. */
  private pendingApproval: { code: string | null } | null = null;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(options: AiImageServiceOptions) {
    this.options = options;
    this.maxRenders = options.maxRenders ?? DEFAULT_MAX_RENDERS;
    let previous: ProviderImages | null = options.images();
    this.unsubscribe = options.onStatus(() => {
      const current = this.options.images();
      // The connection changed under in-flight work: nobody can finish it.
      if (current !== previous) {
        previous = current;
        this.abortAll();
      }
      void this.refreshAccess();
    });
  }

  onAccess(listener: (access: AiImageAccess) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async access(): Promise<AiImageAccess> {
    const access = await this.computeAccess();
    this.publish(access);
    return access;
  }

  async requestAccess(): Promise<AiResult<AiImageAccess>> {
    const images = this.options.images();
    const current = await this.computeAccess();
    if (current.kind !== 'needs-approval' || !images) {
      return current.kind === 'ready'
        ? { ok: true, value: current }
        : {
            ok: false,
            error: aiError(
              'unsupported',
              current.kind === 'unavailable'
                ? current.message
                : 'Image generation cannot be allowed right now.',
            ),
          };
    }
    if (this.pendingApproval) {
      return {
        ok: false,
        error: aiError('budget-exceeded', 'Gezel is already waiting for your approval.'),
      };
    }
    this.pendingApproval = { code: null };
    this.publish({ kind: 'awaiting-approval', verificationCode: null });
    try {
      await images.requestAccess((code) => {
        if (!this.pendingApproval) return;
        this.pendingApproval.code = code;
        this.publish({ kind: 'awaiting-approval', verificationCode: code });
      });
      this.pendingApproval = null;
      return { ok: true, value: await this.access() };
    } catch (error) {
      this.pendingApproval = null;
      void this.refreshAccess();
      return { ok: false, error: imageError(error) };
    }
  }

  async models(): Promise<AiResult<readonly AiImageModel[]>> {
    const images = this.options.images();
    if (!images)
      return { ok: false, error: aiError('provider-unavailable', NOT_CONNECTED.message) };
    const controller = new AbortController();
    const clear = timeoutSignal(controller, LOOKUP_TIMEOUT_MS);
    try {
      const models = await images.models(controller.signal);
      return { ok: true, value: dedupe(models.map(toAiImageModel)) };
    } catch (error) {
      return { ok: false, error: imageError(error) };
    } finally {
      clear();
    }
  }

  async removeModel(id: string): Promise<AiResult<null>> {
    const images = this.options.images();
    if (!images)
      return { ok: false, error: aiError('provider-unavailable', NOT_CONNECTED.message) };
    const controller = new AbortController();
    const clear = timeoutSignal(controller, LOOKUP_TIMEOUT_MS);
    try {
      await images.remove(id, controller.signal);
      const preferences = await this.options.preferences.get();
      const patch: AiImagePreferencesPatch = {
        ...(preferences.model === id ? { model: null } : {}),
        ...(preferences.designModel === id ? { designModel: null } : {}),
      };
      if (Object.keys(patch).length > 0) await this.options.preferences.set(patch);
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, error: imageError(error) };
    } finally {
      clear();
    }
  }

  getPreferences(): Promise<AiImagePreferences> {
    return this.options.preferences.get();
  }

  setPreferences(patch: AiImagePreferencesPatch): Promise<AiImagePreferences> {
    return this.options.preferences.set(patch);
  }

  startInstall(key: string, id: string, emit: AiImageInstallEmitter): void {
    let ended = false;
    const end = (event: Extract<AiImageInstallEvent, { kind: 'done' | 'error' }>) => {
      if (ended) return;
      ended = true;
      this.installs.delete(key);
      emit(event);
    };
    const images = this.options.images();
    if (this.disposed || !images) {
      end({ kind: 'error', error: aiError('provider-unavailable', NOT_CONNECTED.message) });
      return;
    }
    if (this.installs.has(key)) {
      end({ kind: 'error', error: aiError('unknown', 'That download is already running.') });
      return;
    }
    if (this.installs.size >= MAX_INSTALLS) {
      end({ kind: 'error', error: aiError('budget-exceeded') });
      return;
    }
    const controller = new AbortController();
    this.installs.set(key, controller);
    let jobId: string | null = null;
    controller.signal.addEventListener(
      'abort',
      () => {
        if (jobId) void images.cancelEnsure(jobId).catch(() => undefined);
      },
      { once: true },
    );
    void (async () => {
      try {
        const started = await images.ensure(id, controller.signal);
        if (started.status === 'downloading') {
          jobId = started.jobId;
          if (controller.signal.aborted) void images.cancelEnsure(jobId).catch(() => undefined);
          for await (const event of images.ensureEvents(started.jobId, controller.signal)) {
            if (event.type === 'error') {
              throw new AiHostError(
                'model-download-failed',
                'Gezel could not download the model.',
                event.error,
              );
            }
            if (event.type === 'done') break;
            emit({ kind: 'progress', progress: installProgress(event) });
          }
        }
        if (controller.signal.aborted)
          throw new AiHostError('cancelled', 'The download was cancelled.');
        const listed = await images.models(controller.signal);
        const model = listed.find((entry) => entry.id === id);
        if (!model) throw new AiHostError('model-unavailable', 'Gezel no longer lists that model.');
        end({ kind: 'done', model: toAiImageModel(model) });
      } catch (error) {
        end({
          kind: 'error',
          error: controller.signal.aborted
            ? aiError('cancelled', 'The download was cancelled.')
            : imageError(error),
        });
      }
    })();
  }

  cancelInstall(key: string): void {
    this.installs.get(key)?.abort();
  }

  startGenerate(key: string, request: AiImageRequest, emit: AiImageEmitter): void {
    let ended = false;
    const end = (event: Extract<AiImageEvent, { kind: 'done' | 'error' }>) => {
      if (ended) return;
      ended = true;
      this.renders.delete(key);
      emit(event);
    };
    const images = this.options.images();
    if (this.disposed || !images) {
      end({ kind: 'error', error: aiError('provider-unavailable', NOT_CONNECTED.message) });
      return;
    }
    if (this.renders.has(key)) {
      end({ kind: 'error', error: aiError('unknown', 'That image is already being generated.') });
      return;
    }
    if (this.renders.size >= this.maxRenders) {
      end({
        kind: 'error',
        error: aiError(
          'budget-exceeded',
          'Another image is being generated. Wait for it to finish.',
        ),
      });
      return;
    }
    const controller = new AbortController();
    this.renders.set(key, controller);
    void (async () => {
      try {
        const preferences = await this.options.preferences.get();
        const model = request.model ?? preferences.model ?? undefined;
        const image = await images.generate(
          {
            prompt: request.prompt,
            ...(request.negativePrompt ? { negativePrompt: request.negativePrompt } : {}),
            ...(model ? { model } : {}),
            aspectRatio: request.aspect ?? preferences.aspect,
            ...(request.seed !== undefined ? { seed: request.seed } : {}),
          },
          {
            signal: controller.signal,
            onProgress: (progress) => {
              if (ended) return;
              emit({
                kind: 'progress',
                progress: {
                  phase: PHASES[progress.phase] ?? 'sampling',
                  step: Math.max(0, Math.floor(progress.step)),
                  totalSteps: Math.max(0, Math.floor(progress.totalSteps)),
                  secondsPerStep:
                    progress.secondsPerStep !== undefined &&
                    Number.isFinite(progress.secondsPerStep)
                      ? progress.secondsPerStep
                      : null,
                },
              });
            },
          },
        );
        end({
          kind: 'done',
          image: {
            mimeType: 'image/png',
            data: ownedArrayBuffer(image.png),
            width: image.width,
            height: image.height,
            seed: image.seed,
            model: image.model,
            durationMs: Math.max(0, Math.round(image.durationMs)),
          },
        });
      } catch (error) {
        if (!controller.signal.aborted && imageError(error).code === 'approval-required') {
          void this.refreshAccess();
        }
        end({
          kind: 'error',
          error: controller.signal.aborted
            ? aiError('cancelled', 'The image was cancelled.')
            : imageError(error),
        });
      }
    })();
  }

  cancelGenerate(key: string): void {
    this.renders.get(key)?.abort();
  }

  activeRenders(): number {
    return this.renders.size;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.abortAll();
    this.listeners.clear();
  }

  private abortAll(): void {
    for (const controller of [...this.renders.values(), ...this.installs.values()]) {
      controller.abort();
    }
  }

  private async refreshAccess(): Promise<void> {
    try {
      this.publish(await this.computeAccess());
    } catch {
      /* the next read recomputes */
    }
  }

  private publish(access: AiImageAccess): void {
    const shown: AiImageAccess = this.pendingApproval
      ? { kind: 'awaiting-approval', verificationCode: this.pendingApproval.code }
      : access;
    if (this.lastAccess && JSON.stringify(this.lastAccess) === JSON.stringify(shown)) return;
    this.lastAccess = shown;
    for (const listener of this.listeners) {
      try {
        listener(shown);
      } catch {
        /* one listener cannot stop the others */
      }
    }
  }

  private async computeAccess(): Promise<AiImageAccess> {
    if (this.pendingApproval) {
      return { kind: 'awaiting-approval', verificationCode: this.pendingApproval.code };
    }
    const blocked = this.options.blocked?.();
    if (blocked) return blocked;
    const status = await this.options.status();
    const images = this.options.images();
    if (status.kind !== 'ready') return NOT_CONNECTED;
    if (!images) return { kind: 'provider-outdated' };
    const controller = new AbortController();
    const clear = timeoutSignal(controller, LOOKUP_TIMEOUT_MS);
    try {
      switch (await images.access(controller.signal)) {
        case 'granted':
          return { kind: 'ready' };
        case 'needs-approval':
          return { kind: 'needs-approval' };
        case 'no-engine':
          return NO_ENGINE;
        default:
          return { kind: 'provider-outdated' };
      }
    } catch (error) {
      const failure = imageError(error);
      return {
        kind: 'unavailable',
        reason: 'not-connected',
        message: failure.message,
      };
    } finally {
      clear();
    }
  }
}

function dedupe(models: AiImageModel[]): AiImageModel[] {
  const seen = new Set<string>();
  return models.filter((model) => !seen.has(model.id) && seen.add(model.id));
}

function installProgress(event: ProviderEnsureEvent): AiProgress {
  if (event.type === 'progress') {
    const percent =
      event.totalBytes > 0 ? Math.min(100, (event.bytesWritten / event.totalBytes) * 100) : null;
    return { phase: 'downloading', message: 'Downloading the image model…', percent };
  }
  if (event.type === 'retrying') {
    return {
      phase: 'retrying',
      message: clip(
        `Connection interrupted; retrying (${event.attempt} of ${event.maxAttempts}).`,
        HOST_WIRE_LIMITS.messageCharacters,
      ),
      percent: null,
    };
  }
  return { phase: 'verifying', message: 'Checking the download…', percent: null };
}
