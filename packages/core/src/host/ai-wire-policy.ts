import { HOST_WIRE_LIMITS, isBoundedString } from './wire-policy.js';
import type {
  AiChatEvent,
  AiChatMessage,
  AiChatPurpose,
  AiChatRequest,
  AiConnectionStep,
  AiError,
  AiErrorCode,
  AiModelInfo,
  AiPreferences,
  AiPreferencesPatch,
  AiProgress,
  AiReviewMode,
  AiStatus,
  AiUnavailableReason,
} from './ai.js';

/**
 * Bounds for the AI boundary.
 *
 * These are deliberately separate from `HOST_WIRE_LIMITS`: a prompt is not a
 * document, and a delta is not a label. Sizing them together would mean either
 * a 20 MiB prompt or a 2 KiB completion.
 */
export const AI_WIRE_LIMITS = Object.freeze({
  messageEntries: 64,
  /** Sum of every message's content in one request. */
  promptCharacters: 256 * 1024,
  deltaCharacters: 16 * 1024,
  /** The host aborts a stream whose accumulated text passes this. */
  completionCharacters: 256 * 1024,
  maxTokensCeiling: 32_768,
  temperatureCeiling: 2,
  verificationCodeCharacters: 16,
  progressPhaseCharacters: 64,
  modelEntries: 200,
  contextWindowCeiling: 8_000_000,
});

const CHAT_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant']);
const CHAT_PURPOSES: ReadonlySet<string> = new Set(['write', 'review', 'chat']);
const REVIEW_MODES: ReadonlySet<string> = new Set(['off', 'explicit', 'implicit']);
const FINISH_REASONS: ReadonlySet<string> = new Set(['stop', 'length', 'cancelled']);
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'opt-out',
  'platform-unsupported',
  'not-installed',
  'not-running',
  'disconnected',
]);
const CONNECTION_STEPS: ReadonlySet<string> = new Set([
  'detecting',
  'awaiting-approval',
  'preparing-model',
  'preparing-workspace',
]);
const PROVIDER_MODES: ReadonlySet<string> = new Set(['installed', 'hosted', 'remote']);
const ERROR_CODES: ReadonlySet<string> = new Set([
  'provider-unavailable',
  'approval-denied',
  'approval-timeout',
  'approval-expired',
  'approval-required',
  'inference-disabled',
  'already-connected',
  'model-unavailable',
  'model-download-failed',
  'runtime-missing',
  'workspace-not-registered',
  'unsupported',
  'budget-exceeded',
  'rate-limited',
  'timeout',
  'cancelled',
  'unknown',
]);

type AiChatCompletionUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
} | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** Allow a fixed key set, with a declared subset permitted to be absent. */
function hasKeysWithin(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function isNonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum;
}

export function parseAiError(value: unknown): AiError | null {
  if (!isRecord(value)) return null;
  if (!hasKeysWithin(value, ['code', 'message'], ['detail'])) return null;
  if (typeof value.code !== 'string' || !ERROR_CODES.has(value.code)) return null;
  if (!isBoundedString(value.message, HOST_WIRE_LIMITS.messageCharacters)) return null;
  if (
    value.detail !== undefined &&
    !isBoundedString(value.detail, HOST_WIRE_LIMITS.messageCharacters)
  ) {
    return null;
  }
  const error: AiError = {
    code: value.code as AiErrorCode,
    message: value.message,
    ...(value.detail === undefined ? {} : { detail: value.detail as string }),
  };
  return error;
}

export function parseAiProgress(value: unknown): AiProgress | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['phase', 'message', 'percent'])) return null;
  if (!isBoundedString(value.phase, AI_WIRE_LIMITS.progressPhaseCharacters, 1)) return null;
  if (!isBoundedString(value.message, HOST_WIRE_LIMITS.messageCharacters)) return null;
  if (value.percent !== null && !isFiniteInRange(value.percent, 0, 100)) return null;
  return { phase: value.phase, message: value.message, percent: value.percent as number | null };
}

export function parseAiModelInfo(value: unknown): AiModelInfo | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['id', 'label', 'local', 'contextWindow', 'isDefault'])) return null;
  if (!isBoundedString(value.id, HOST_WIRE_LIMITS.identifierCharacters, 1)) return null;
  if (!isBoundedString(value.label, HOST_WIRE_LIMITS.labelCharacters, 1)) return null;
  if (typeof value.local !== 'boolean') return null;
  if (typeof value.isDefault !== 'boolean') return null;
  if (
    value.contextWindow !== null &&
    !isNonNegativeInteger(value.contextWindow, AI_WIRE_LIMITS.contextWindowCeiling)
  ) {
    return null;
  }
  return {
    id: value.id,
    label: value.label,
    local: value.local,
    contextWindow: value.contextWindow as number | null,
    isDefault: value.isDefault,
  };
}

export function parseAiModelInfoList(value: unknown): AiModelInfo[] | null {
  if (!Array.isArray(value) || value.length > AI_WIRE_LIMITS.modelEntries) return null;
  const models: AiModelInfo[] = [];
  for (const entry of value) {
    const model = parseAiModelInfo(entry);
    if (!model) return null;
    models.push(model);
  }
  return models;
}

function parseAiChatMessage(value: unknown): AiChatMessage | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['role', 'content'])) return null;
  if (typeof value.role !== 'string' || !CHAT_ROLES.has(value.role)) return null;
  if (!isBoundedString(value.content, AI_WIRE_LIMITS.promptCharacters)) return null;
  return { role: value.role as AiChatMessage['role'], content: value.content };
}

/**
 * Parse a renderer-originated chat request.
 *
 * The per-message bound is not enough on its own: sixty-four messages each just
 * under the cap would be sixteen megabytes of prompt. The total is what is
 * actually checked here.
 */
export function parseAiChatRequest(value: unknown): AiChatRequest | null {
  if (!isRecord(value)) return null;
  if (!hasKeysWithin(value, ['messages', 'purpose'], ['model', 'temperature', 'maxTokens'])) {
    return null;
  }
  if (typeof value.purpose !== 'string' || !CHAT_PURPOSES.has(value.purpose)) return null;
  if (!Array.isArray(value.messages)) return null;
  if (value.messages.length < 1 || value.messages.length > AI_WIRE_LIMITS.messageEntries)
    return null;

  const messages: AiChatMessage[] = [];
  let totalCharacters = 0;
  for (const entry of value.messages) {
    const message = parseAiChatMessage(entry);
    if (!message) return null;
    totalCharacters += message.content.length;
    if (totalCharacters > AI_WIRE_LIMITS.promptCharacters) return null;
    messages.push(message);
  }

  if (
    value.model !== undefined &&
    !isBoundedString(value.model, HOST_WIRE_LIMITS.identifierCharacters, 1)
  ) {
    return null;
  }
  if (
    value.temperature !== undefined &&
    !isFiniteInRange(value.temperature, 0, AI_WIRE_LIMITS.temperatureCeiling)
  ) {
    return null;
  }
  if (
    value.maxTokens !== undefined &&
    !isNonNegativeInteger(value.maxTokens, AI_WIRE_LIMITS.maxTokensCeiling)
  ) {
    return null;
  }

  return {
    messages,
    purpose: value.purpose as AiChatPurpose,
    ...(value.model === undefined ? {} : { model: value.model as string }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature as number }),
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens as number }),
  };
}

export function parseAiChatEvent(value: unknown): AiChatEvent | null {
  if (!isRecord(value)) return null;

  if (value.kind === 'delta') {
    if (!hasExactKeys(value, ['kind', 'text'])) return null;
    if (!isBoundedString(value.text, AI_WIRE_LIMITS.deltaCharacters)) return null;
    return { kind: 'delta', text: value.text };
  }

  if (value.kind === 'done') {
    if (!hasExactKeys(value, ['kind', 'completion'])) return null;
    const completion = value.completion;
    if (!isRecord(completion)) return null;
    if (!hasExactKeys(completion, ['text', 'model', 'finishReason', 'usage'])) return null;
    if (!isBoundedString(completion.text, AI_WIRE_LIMITS.completionCharacters)) return null;
    if (!isBoundedString(completion.model, HOST_WIRE_LIMITS.identifierCharacters, 1)) return null;
    if (
      typeof completion.finishReason !== 'string' ||
      !FINISH_REASONS.has(completion.finishReason)
    ) {
      return null;
    }
    let usage: AiChatCompletionUsage = null;
    if (completion.usage !== null) {
      if (!isRecord(completion.usage)) return null;
      if (!hasExactKeys(completion.usage, ['promptTokens', 'completionTokens'])) return null;
      if (!isNonNegativeInteger(completion.usage.promptTokens, Number.MAX_SAFE_INTEGER))
        return null;
      if (!isNonNegativeInteger(completion.usage.completionTokens, Number.MAX_SAFE_INTEGER)) {
        return null;
      }
      usage = {
        promptTokens: completion.usage.promptTokens,
        completionTokens: completion.usage.completionTokens,
      };
    }
    return {
      kind: 'done',
      completion: {
        text: completion.text,
        model: completion.model,
        finishReason: completion.finishReason as 'stop' | 'length' | 'cancelled',
        usage,
      },
    };
  }

  if (value.kind === 'error') {
    if (!hasExactKeys(value, ['kind', 'error'])) return null;
    const error = parseAiError(value.error);
    return error ? { kind: 'error', error } : null;
  }

  return null;
}

export function parseAiStatus(value: unknown): AiStatus | null {
  if (!isRecord(value)) return null;

  if (value.kind === 'unavailable') {
    if (!hasExactKeys(value, ['kind', 'reason'])) return null;
    if (typeof value.reason !== 'string' || !UNAVAILABLE_REASONS.has(value.reason)) return null;
    return { kind: 'unavailable', reason: value.reason as AiUnavailableReason };
  }

  if (value.kind === 'connecting') {
    if (!hasExactKeys(value, ['kind', 'step', 'verificationCode', 'progress'])) return null;
    if (typeof value.step !== 'string' || !CONNECTION_STEPS.has(value.step)) return null;
    if (
      value.verificationCode !== null &&
      !isBoundedString(value.verificationCode, AI_WIRE_LIMITS.verificationCodeCharacters, 1)
    ) {
      return null;
    }
    let progress: AiProgress | null = null;
    if (value.progress !== null) {
      progress = parseAiProgress(value.progress);
      if (!progress) return null;
    }
    return {
      kind: 'connecting',
      step: value.step as AiConnectionStep,
      verificationCode: value.verificationCode as string | null,
      progress,
    };
  }

  if (value.kind === 'ready') {
    if (!hasExactKeys(value, ['kind', 'provider', 'model', 'activeRequests'])) return null;
    const provider = value.provider;
    if (!isRecord(provider)) return null;
    if (!hasExactKeys(provider, ['name', 'version', 'mode'])) return null;
    if (!isBoundedString(provider.name, HOST_WIRE_LIMITS.labelCharacters, 1)) return null;
    if (
      provider.version !== null &&
      !isBoundedString(provider.version, HOST_WIRE_LIMITS.labelCharacters)
    ) {
      return null;
    }
    if (typeof provider.mode !== 'string' || !PROVIDER_MODES.has(provider.mode)) return null;
    if (!isNonNegativeInteger(value.activeRequests, AI_WIRE_LIMITS.messageEntries)) return null;
    let model: AiModelInfo | null = null;
    if (value.model !== null) {
      model = parseAiModelInfo(value.model);
      if (!model) return null;
    }
    return {
      kind: 'ready',
      provider: {
        name: provider.name,
        version: provider.version as string | null,
        mode: provider.mode as 'installed' | 'hosted' | 'remote',
      },
      model,
      activeRequests: value.activeRequests,
    };
  }

  if (value.kind === 'error') {
    if (!hasExactKeys(value, ['kind', 'error', 'retryable'])) return null;
    if (typeof value.retryable !== 'boolean') return null;
    const error = parseAiError(value.error);
    return error ? { kind: 'error', error, retryable: value.retryable } : null;
  }

  return null;
}

export function parseAiPreferences(value: unknown): AiPreferences | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['enabled', 'model', 'reviewMode'])) return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (
    value.model !== null &&
    !isBoundedString(value.model, HOST_WIRE_LIMITS.identifierCharacters, 1)
  ) {
    return null;
  }
  if (typeof value.reviewMode !== 'string' || !REVIEW_MODES.has(value.reviewMode)) return null;
  return {
    enabled: value.enabled,
    model: value.model as string | null,
    reviewMode: value.reviewMode as AiReviewMode,
  };
}

/** Parse a partial update. An empty patch is valid and means "change nothing". */
export function parseAiPreferencesPatch(value: unknown): AiPreferencesPatch | null {
  if (!isRecord(value)) return null;
  if (!hasKeysWithin(value, [], ['enabled', 'model', 'reviewMode'])) return null;
  const patch: { enabled?: boolean; model?: string | null; reviewMode?: AiReviewMode } = {};
  if (Object.prototype.hasOwnProperty.call(value, 'enabled')) {
    if (typeof value.enabled !== 'boolean') return null;
    patch.enabled = value.enabled;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'model')) {
    if (
      value.model !== null &&
      !isBoundedString(value.model, HOST_WIRE_LIMITS.identifierCharacters, 1)
    ) {
      return null;
    }
    patch.model = value.model as string | null;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'reviewMode')) {
    if (typeof value.reviewMode !== 'string' || !REVIEW_MODES.has(value.reviewMode)) return null;
    patch.reviewMode = value.reviewMode as AiReviewMode;
  }
  return patch;
}
