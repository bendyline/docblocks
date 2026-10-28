import type { AiError, AiProgress, AiResult } from './ai.js';
import { parseAiError, parseAiProgress } from './ai-wire-policy.js';
import { HOST_WIRE_LIMITS, isBoundedString } from './wire-policy.js';

/**
 * On-device image generation.
 *
 * Renders run on the provider's local image engine. They take seconds on a
 * fast graphics card and minutes for the largest models, so a request streams
 * phased progress and can be cancelled; cancelling stops the engine, and the
 * next render reloads its weights. Image models are listed apart from chat
 * models and never appear in a chat model picker.
 */

/** Shapes a person can ask for. The provider picks pixels inside the model's range. */
export const AI_IMAGE_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;
export type AiImageAspect = (typeof AI_IMAGE_ASPECTS)[number];

export type AiImageUnavailableReason =
  /** AI is off, or the provider is not connected. */
  | 'not-connected'
  /** The provider has no image engine that can run on this computer. */
  | 'no-engine'
  /** The graphics driver lacks what the engine needs (Vulkan on Windows). */
  | 'graphics-driver'
  /** This build of the app cannot run image generation. */
  | 'platform';

/**
 * Whether image generation can be offered now.
 *
 * `needs-approval` means the provider serves images but this app has not been
 * allowed to use them; ask with `requestAccess()` from an explicit gesture.
 * While that request waits, the state is `awaiting-approval` with the code the
 * person types into the provider. Chat keeps working throughout.
 */
export type AiImageAccess =
  | { readonly kind: 'ready' }
  | { readonly kind: 'needs-approval' }
  | { readonly kind: 'awaiting-approval'; readonly verificationCode: string | null }
  | { readonly kind: 'provider-outdated' }
  | {
      readonly kind: 'unavailable';
      readonly reason: AiImageUnavailableReason;
      readonly message: string;
    };

export const AI_IMAGE_FIT_VERDICTS = [
  'fits',
  'tight',
  'over-limit',
  'may-not-run',
  'wont-run',
] as const;

export interface AiImageModelFit {
  /** `wont-run` models refuse to install on this computer. */
  readonly verdict: (typeof AI_IMAGE_FIT_VERDICTS)[number];
  /** One sentence a person can act on; empty for a plain fit. */
  readonly reason: string;
}

export interface AiImageModel {
  /** Opaque to the renderer. */
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly state: 'installed' | 'download-required' | 'downloading';
  readonly downloadBytes: number | null;
  /** Installed in a store the provider reads but this app does not own; not removable here. */
  readonly shared: boolean;
  readonly license: string | null;
  /** False when the license forbids commercial use; null when the provider does not say. */
  readonly commercialUse: boolean | null;
  /** Draws legible text, which design graphics depend on. */
  readonly rendersText: boolean;
  /** How the model reads prompts. */
  readonly promptStyle: 'sentences' | 'tags' | null;
  /** `workstation` marks a model for a machine with a great deal of memory. */
  readonly hardwareTier: 'low' | 'mid' | 'high' | 'workstation' | null;
  readonly minRamGb: number | null;
  readonly fit: AiImageModelFit | null;
}

export interface AiImagePreferences {
  /** The model "Generate image" uses; null lets the provider choose an installed one. */
  readonly model: string | null;
  /** The model Illustrate's design graphics use; null offers none. */
  readonly designModel: string | null;
  readonly aspect: AiImageAspect;
}

export type AiImagePreferencesPatch = Partial<AiImagePreferences>;

export interface AiImageRequest {
  readonly prompt: string;
  readonly negativePrompt?: string;
  /** An id from `models()`; the preferred model when absent. */
  readonly model?: string;
  readonly aspect?: AiImageAspect;
  readonly seed?: number;
}

export interface AiImageResult {
  readonly mimeType: 'image/png';
  readonly data: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly model: string;
  readonly durationMs: number;
}

/**
 * `loading-model` covers the first render after the engine starts, which
 * loads the weights; `decoding` turns the result into pixels in tiles.
 */
export type AiImagePhase = 'queued' | 'loading-model' | 'sampling' | 'decoding';

export interface AiImageProgress {
  readonly phase: AiImagePhase;
  /** Units done in this phase; 0 while queued or when the engine reports none. */
  readonly step: number;
  readonly totalSteps: number;
  readonly secondsPerStep: number | null;
}

export type AiImageEvent =
  | { readonly kind: 'progress'; readonly progress: AiImageProgress }
  | { readonly kind: 'done'; readonly image: AiImageResult }
  | { readonly kind: 'error'; readonly error: AiError };

export interface AiImageHandle {
  readonly done: Promise<AiResult<AiImageResult>>;
  /** Stop the render. The engine stops, so the next render reloads its weights. */
  cancel(): void;
}

export type AiImageInstallEvent =
  | { readonly kind: 'progress'; readonly progress: AiProgress }
  | { readonly kind: 'done'; readonly model: AiImageModel }
  | { readonly kind: 'error'; readonly error: AiError };

export interface AiImageInstallHandle {
  readonly done: Promise<AiResult<AiImageModel>>;
  /** Stop the download. Starting it again resumes. */
  cancel(): void;
}

export interface AiImagesAPI {
  access(): Promise<AiImageAccess>;
  onAccess(listener: (access: AiImageAccess) => void): () => void;
  /** Ask the provider to allow image generation. Only from an explicit gesture. */
  requestAccess(): Promise<AiResult<AiImageAccess>>;
  models(): Promise<AiResult<readonly AiImageModel[]>>;
  /** Start a model download from an explicit gesture. */
  installModel(id: string, onProgress?: (progress: AiProgress) => void): AiImageInstallHandle;
  removeModel(id: string): Promise<AiResult<null>>;
  getPreferences(): Promise<AiImagePreferences>;
  setPreferences(patch: AiImagePreferencesPatch): Promise<AiImagePreferences>;
  generate(request: AiImageRequest, onEvent: (event: AiImageEvent) => void): AiImageHandle;
}

export const AI_IMAGE_WIRE_LIMITS = Object.freeze({
  promptCharacters: 4_000,
  /** A PNG at the largest size a model renders. */
  imageBytes: 64 * 1024 * 1024,
  models: 256,
  pixels: 16_384,
  verificationCodeCharacters: 16,
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function within(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

const label = (value: unknown): value is string =>
  isBoundedString(value, HOST_WIRE_LIMITS.labelCharacters, 1);
const message = (value: unknown): value is string =>
  isBoundedString(value, HOST_WIRE_LIMITS.messageCharacters);
const nullableLabel = (value: unknown): value is string | null => value === null || label(value);
const count = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const pixels = (value: unknown): value is number =>
  count(value, AI_IMAGE_WIRE_LIMITS.pixels) && value > 0;

export function isAiImageModelId(value: unknown): value is string {
  return isBoundedString(value, HOST_WIRE_LIMITS.identifierCharacters, 1);
}

export function isAiImageAspect(value: unknown): value is AiImageAspect {
  return typeof value === 'string' && (AI_IMAGE_ASPECTS as readonly string[]).includes(value);
}

export function parseAiImageAccess(value: unknown): AiImageAccess | null {
  if (!record(value)) return null;
  switch (value.kind) {
    case 'ready':
    case 'needs-approval':
    case 'provider-outdated':
      return exact(value, ['kind']) ? { kind: value.kind } : null;
    case 'awaiting-approval':
      if (!exact(value, ['kind', 'verificationCode'])) return null;
      if (
        value.verificationCode !== null &&
        !isBoundedString(value.verificationCode, AI_IMAGE_WIRE_LIMITS.verificationCodeCharacters, 1)
      )
        return null;
      return { kind: 'awaiting-approval', verificationCode: value.verificationCode };
    case 'unavailable':
      if (!exact(value, ['kind', 'reason', 'message']) || !message(value.message)) return null;
      if (
        value.reason !== 'not-connected' &&
        value.reason !== 'no-engine' &&
        value.reason !== 'graphics-driver' &&
        value.reason !== 'platform'
      )
        return null;
      return { kind: 'unavailable', reason: value.reason, message: value.message };
    default:
      return null;
  }
}

const MODEL_KEYS = [
  'id',
  'label',
  'description',
  'state',
  'downloadBytes',
  'shared',
  'license',
  'commercialUse',
  'rendersText',
  'promptStyle',
  'hardwareTier',
  'minRamGb',
  'fit',
] as const;

export function parseAiImageModel(value: unknown): AiImageModel | null {
  if (!record(value) || !exact(value, MODEL_KEYS)) return null;
  if (!isAiImageModelId(value.id) || !label(value.label)) return null;
  if (value.description !== null && !message(value.description)) return null;
  if (
    value.state !== 'installed' &&
    value.state !== 'download-required' &&
    value.state !== 'downloading'
  )
    return null;
  if (value.downloadBytes !== null && !count(value.downloadBytes)) return null;
  if (typeof value.shared !== 'boolean' || typeof value.rendersText !== 'boolean') return null;
  if (!nullableLabel(value.license)) return null;
  if (value.commercialUse !== null && typeof value.commercialUse !== 'boolean') return null;
  if (
    value.promptStyle !== null &&
    value.promptStyle !== 'sentences' &&
    value.promptStyle !== 'tags'
  )
    return null;
  if (
    value.hardwareTier !== null &&
    value.hardwareTier !== 'low' &&
    value.hardwareTier !== 'mid' &&
    value.hardwareTier !== 'high' &&
    value.hardwareTier !== 'workstation'
  )
    return null;
  if (value.minRamGb !== null && !count(value.minRamGb, 1_000_000)) return null;
  let fit: AiImageModelFit | null = null;
  if (value.fit !== null) {
    const raw = value.fit;
    if (
      !record(raw) ||
      !exact(raw, ['verdict', 'reason']) ||
      typeof raw.verdict !== 'string' ||
      !(AI_IMAGE_FIT_VERDICTS as readonly string[]).includes(raw.verdict) ||
      !message(raw.reason)
    )
      return null;
    fit = { verdict: raw.verdict as AiImageModelFit['verdict'], reason: raw.reason };
  }
  return {
    id: value.id,
    label: value.label,
    description: value.description as string | null,
    state: value.state,
    downloadBytes: value.downloadBytes as number | null,
    shared: value.shared,
    license: value.license,
    commercialUse: value.commercialUse as boolean | null,
    rendersText: value.rendersText,
    promptStyle: value.promptStyle,
    hardwareTier: value.hardwareTier,
    minRamGb: value.minRamGb as number | null,
    fit,
  };
}

export function parseAiImageModelList(value: unknown): AiImageModel[] | null {
  if (!Array.isArray(value) || value.length > AI_IMAGE_WIRE_LIMITS.models) return null;
  const models: AiImageModel[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const model = parseAiImageModel(raw);
    if (!model || ids.has(model.id)) return null;
    ids.add(model.id);
    models.push(model);
  }
  return models;
}

export function parseAiImagePreferences(value: unknown): AiImagePreferences | null {
  if (!record(value) || !exact(value, ['model', 'designModel', 'aspect'])) return null;
  if (value.model !== null && !isAiImageModelId(value.model)) return null;
  if (value.designModel !== null && !isAiImageModelId(value.designModel)) return null;
  if (!isAiImageAspect(value.aspect)) return null;
  return { model: value.model, designModel: value.designModel, aspect: value.aspect };
}

export function parseAiImagePreferencesPatch(value: unknown): AiImagePreferencesPatch | null {
  if (!record(value) || !within(value, [], ['model', 'designModel', 'aspect'])) return null;
  const patch: { -readonly [K in keyof AiImagePreferences]?: AiImagePreferences[K] } = {};
  if ('model' in value) {
    if (value.model !== null && !isAiImageModelId(value.model)) return null;
    patch.model = value.model;
  }
  if ('designModel' in value) {
    if (value.designModel !== null && !isAiImageModelId(value.designModel)) return null;
    patch.designModel = value.designModel;
  }
  if ('aspect' in value) {
    if (!isAiImageAspect(value.aspect)) return null;
    patch.aspect = value.aspect;
  }
  return patch;
}

export function parseAiImageRequest(value: unknown): AiImageRequest | null {
  if (!record(value) || !within(value, ['prompt'], ['negativePrompt', 'model', 'aspect', 'seed']))
    return null;
  if (!isBoundedString(value.prompt, AI_IMAGE_WIRE_LIMITS.promptCharacters, 1)) return null;
  if (!value.prompt.trim()) return null;
  if (
    value.negativePrompt !== undefined &&
    !isBoundedString(value.negativePrompt, AI_IMAGE_WIRE_LIMITS.promptCharacters)
  )
    return null;
  if (value.model !== undefined && !isAiImageModelId(value.model)) return null;
  if (value.aspect !== undefined && !isAiImageAspect(value.aspect)) return null;
  if (value.seed !== undefined && !count(value.seed, 2_147_483_647)) return null;
  return {
    prompt: value.prompt,
    ...(value.negativePrompt !== undefined
      ? { negativePrompt: value.negativePrompt as string }
      : {}),
    ...(value.model !== undefined ? { model: value.model as string } : {}),
    ...(value.aspect !== undefined ? { aspect: value.aspect as AiImageAspect } : {}),
    ...(value.seed !== undefined ? { seed: value.seed as number } : {}),
  };
}

/**
 * Copy a structured-cloned byte payload into a buffer the caller owns. IPC may
 * deliver an ArrayBuffer or a typed-array view.
 */
function ownedBuffer(value: unknown, maximumBytes: number): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) {
    return value.byteLength <= maximumBytes ? value.slice(0) : null;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    if (value.byteLength > maximumBytes) return null;
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy.buffer;
  }
  return null;
}

function isPng(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 24) return false;
  const bytes = new Uint8Array(buffer, 0, PNG_SIGNATURE.length);
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function parseAiImageResult(value: unknown): AiImageResult | null {
  if (
    !record(value) ||
    !exact(value, ['mimeType', 'data', 'width', 'height', 'seed', 'model', 'durationMs'])
  )
    return null;
  if (value.mimeType !== 'image/png') return null;
  const data = ownedBuffer(value.data, AI_IMAGE_WIRE_LIMITS.imageBytes);
  if (!data || !isPng(data)) return null;
  if (!pixels(value.width) || !pixels(value.height)) return null;
  if (!count(value.seed) || !count(value.durationMs) || !isAiImageModelId(value.model)) return null;
  return {
    mimeType: 'image/png',
    data,
    width: value.width,
    height: value.height,
    seed: value.seed,
    model: value.model,
    durationMs: value.durationMs,
  };
}

function parseAiImageProgress(value: unknown): AiImageProgress | null {
  if (!record(value) || !exact(value, ['phase', 'step', 'totalSteps', 'secondsPerStep']))
    return null;
  if (
    value.phase !== 'queued' &&
    value.phase !== 'loading-model' &&
    value.phase !== 'sampling' &&
    value.phase !== 'decoding'
  )
    return null;
  if (!count(value.step, 1_000_000) || !count(value.totalSteps, 1_000_000)) return null;
  if (
    value.secondsPerStep !== null &&
    !(
      typeof value.secondsPerStep === 'number' &&
      Number.isFinite(value.secondsPerStep) &&
      value.secondsPerStep >= 0 &&
      value.secondsPerStep <= 86_400
    )
  )
    return null;
  return {
    phase: value.phase,
    step: value.step,
    totalSteps: value.totalSteps,
    secondsPerStep: value.secondsPerStep as number | null,
  };
}

export function parseAiImageEvent(value: unknown): AiImageEvent | null {
  if (!record(value)) return null;
  if (value.kind === 'progress') {
    if (!exact(value, ['kind', 'progress'])) return null;
    const progress = parseAiImageProgress(value.progress);
    return progress ? { kind: 'progress', progress } : null;
  }
  if (value.kind === 'done') {
    if (!exact(value, ['kind', 'image'])) return null;
    const image = parseAiImageResult(value.image);
    return image ? { kind: 'done', image } : null;
  }
  if (value.kind === 'error') {
    if (!exact(value, ['kind', 'error'])) return null;
    const error = parseAiError(value.error);
    return error ? { kind: 'error', error } : null;
  }
  return null;
}

export function parseAiImageInstallEvent(value: unknown): AiImageInstallEvent | null {
  if (!record(value)) return null;
  if (value.kind === 'progress') {
    if (!exact(value, ['kind', 'progress'])) return null;
    const progress = parseAiProgress(value.progress);
    return progress ? { kind: 'progress', progress } : null;
  }
  if (value.kind === 'done') {
    if (!exact(value, ['kind', 'model'])) return null;
    const model = parseAiImageModel(value.model);
    return model ? { kind: 'done', model } : null;
  }
  if (value.kind === 'error') {
    if (!exact(value, ['kind', 'error'])) return null;
    const error = parseAiError(value.error);
    return error ? { kind: 'error', error } : null;
  }
  return null;
}
