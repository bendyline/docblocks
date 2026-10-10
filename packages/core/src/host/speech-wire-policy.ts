import { HOST_WIRE_LIMITS, isBoundedString } from './wire-policy.js';
import type {
  SpeechAudioChunk,
  SpeechCatalog,
  SpeechError,
  SpeechErrorCode,
  SpeechInstallEvent,
  SpeechModelInfo,
  SpeechModelKind,
  SpeechPreferences,
  SpeechPreferencesPatch,
  SpeechProgress,
  SpeechReadiness,
  SpeechReadinessState,
  SpeechResult,
  SpeechSegment,
  SpeechStatus,
  SpeechSynthesisSummary,
  SpeechSynthesizeEvent,
  SpeechSynthesizeRequest,
  SpeechTranscribeRequest,
  SpeechTranscript,
  SpeechVoiceInfo,
  SpeechWordTiming,
} from './speech.js';

/**
 * Bounds for the speech boundary.
 *
 * A dictation take is a few seconds of 16 kHz PCM, so 16 MiB is generous; a
 * synthesis request is a block or a selection, not a whole book. The prompt
 * ceiling matches Gezel's `AUDIO_TRANSCRIBE_PROMPT_MAX_CHARS`.
 */
export const SPEECH_WIRE_LIMITS = Object.freeze({
  transcribeAudioBytes: 16 * 1024 * 1024,
  promptCharacters: 2_000,
  languageCharacters: 16,
  transcriptCharacters: 64 * 1024,
  segmentEntries: 4_096,
  synthesizeTextCharacters: 20_000,
  chunkPcmBytes: 16 * 1024 * 1024,
  chunkWordEntries: 1_024,
  minSampleRate: 8_000,
  maxSampleRate: 96_000,
  minSpeed: 0.5,
  maxSpeed: 2,
  modelEntries: 64,
  voiceEntries: 256,
  /** Seconds; a take or a chunk is never an hour long. */
  durationCeiling: 3_600,
  downloadBytesCeiling: 8 * 1024 ** 3,
});

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const ERROR_CODES: ReadonlySet<string> = new Set([
  'model-missing',
  'model-download-failed',
  'engine-unavailable',
  'engine-failed',
  'invalid-request',
  'busy',
  'timeout',
  'cancelled',
  'unknown',
]);
const READINESS_STATES: ReadonlySet<string> = new Set([
  'ready',
  'download-required',
  'unavailable',
  'permission-required',
]);

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

function isLabel(value: unknown): value is string {
  return isBoundedString(value, HOST_WIRE_LIMITS.labelCharacters);
}

/**
 * Copy a structured-cloned byte payload into a standalone ArrayBuffer. IPC may
 * deliver an ArrayBuffer, a Uint8Array or a Float32Array depending on the side
 * that sent it; callers always get a buffer they own.
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

function hasRiffWaveHeader(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 44) return false;
  const bytes = new Uint8Array(buffer, 0, 12);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

export function isSpeechModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID.test(value);
}

export function parseSpeechModelKind(value: unknown): SpeechModelKind | null {
  return value === 'stt' || value === 'tts' ? value : null;
}

// ── Renderer to host ─────────────────────────────────────────────────────

export function parseSpeechTranscribeRequest(value: unknown): SpeechTranscribeRequest | null {
  if (!isRecord(value)) return null;
  if (!hasKeysWithin(value, ['audio', 'mimeType'], ['prompt', 'language'])) return null;
  if (value.mimeType !== 'audio/wav') return null;
  const audio = ownedBuffer(value.audio, SPEECH_WIRE_LIMITS.transcribeAudioBytes);
  if (!audio || !hasRiffWaveHeader(audio)) return null;
  if (
    value.prompt !== undefined &&
    !isBoundedString(value.prompt, SPEECH_WIRE_LIMITS.promptCharacters)
  ) {
    return null;
  }
  if (
    value.language !== undefined &&
    (!isBoundedString(value.language, SPEECH_WIRE_LIMITS.languageCharacters, 2) ||
      !LANGUAGE_TAG.test(value.language))
  ) {
    return null;
  }
  return {
    audio,
    mimeType: 'audio/wav',
    ...(value.prompt === undefined ? {} : { prompt: value.prompt as string }),
    ...(value.language === undefined ? {} : { language: value.language as string }),
  };
}

export function parseSpeechSynthesizeRequest(value: unknown): SpeechSynthesizeRequest | null {
  if (!isRecord(value)) return null;
  if (!hasKeysWithin(value, ['text'], ['voice', 'speed'])) return null;
  if (!isBoundedString(value.text, SPEECH_WIRE_LIMITS.synthesizeTextCharacters, 1)) return null;
  if (value.voice !== undefined && !isSpeechModelId(value.voice)) return null;
  if (
    value.speed !== undefined &&
    !isFiniteInRange(value.speed, SPEECH_WIRE_LIMITS.minSpeed, SPEECH_WIRE_LIMITS.maxSpeed)
  ) {
    return null;
  }
  return {
    text: value.text,
    ...(value.voice === undefined ? {} : { voice: value.voice as string }),
    ...(value.speed === undefined ? {} : { speed: value.speed as number }),
  };
}

export function parseSpeechPreferencesPatch(value: unknown): SpeechPreferencesPatch | null {
  if (!isRecord(value)) return null;
  if (!hasKeysWithin(value, [], ['sttModel', 'voice', 'speed'])) return null;
  if (value.sttModel !== undefined && value.sttModel !== null && !isSpeechModelId(value.sttModel))
    return null;
  if (value.voice !== undefined && value.voice !== null && !isSpeechModelId(value.voice))
    return null;
  if (
    value.speed !== undefined &&
    !isFiniteInRange(value.speed, SPEECH_WIRE_LIMITS.minSpeed, SPEECH_WIRE_LIMITS.maxSpeed)
  ) {
    return null;
  }
  return {
    ...(value.sttModel === undefined ? {} : { sttModel: value.sttModel as string | null }),
    ...(value.voice === undefined ? {} : { voice: value.voice as string | null }),
    ...(value.speed === undefined ? {} : { speed: value.speed as number }),
  };
}

// ── Host to renderer ─────────────────────────────────────────────────────

export function parseSpeechError(value: unknown): SpeechError | null {
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
  return {
    code: value.code as SpeechErrorCode,
    message: value.message,
    ...(value.detail === undefined ? {} : { detail: value.detail as string }),
  };
}

/** Parse a result envelope, delegating the success payload to `parseValue`. */
export function parseSpeechResult<T>(
  value: unknown,
  parseValue: (value: unknown) => T | null,
): SpeechResult<T> | null {
  if (!isRecord(value)) return null;
  if (value.ok === true && hasExactKeys(value, ['ok', 'value'])) {
    const parsed = parseValue(value.value);
    return parsed === null ? null : { ok: true, value: parsed };
  }
  if (value.ok === false && hasExactKeys(value, ['ok', 'error'])) {
    const error = parseSpeechError(value.error);
    return error ? { ok: false, error } : null;
  }
  return null;
}

/** For `SpeechResult<null>` operations, where `null` is the success payload. */
export function parseSpeechNullResult(value: unknown): SpeechResult<null> | null {
  if (isRecord(value) && value.ok === true && hasExactKeys(value, ['ok', 'value'])) {
    return value.value === null ? { ok: true, value: null } : null;
  }
  return parseSpeechResult(value, () => null) as SpeechResult<null> | null;
}

export function parseSpeechReadiness(value: unknown): SpeechReadiness | null {
  if (!isRecord(value)) return null;
  if (!hasKeysWithin(value, ['state'], ['reason', 'model'])) return null;
  if (typeof value.state !== 'string' || !READINESS_STATES.has(value.state)) return null;
  if (
    value.reason !== undefined &&
    !isBoundedString(value.reason, HOST_WIRE_LIMITS.messageCharacters)
  ) {
    return null;
  }
  if (value.model !== undefined && !isSpeechModelId(value.model)) return null;
  return {
    state: value.state as SpeechReadinessState,
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    ...(value.model === undefined ? {} : { model: value.model as string }),
  };
}

export function parseSpeechStatus(value: unknown): SpeechStatus | null {
  if (!isRecord(value) || !hasExactKeys(value, ['stt', 'tts'])) return null;
  const stt = parseSpeechReadiness(value.stt);
  const tts = parseSpeechReadiness(value.tts);
  return stt && tts ? { stt, tts } : null;
}

function parseHttpsUrl(value: unknown): value is string {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.urlCharacters, 1)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseSpeechModelInfo(value: unknown): SpeechModelInfo | null {
  if (!isRecord(value)) return null;
  if (
    !hasKeysWithin(
      value,
      [
        'id',
        'kind',
        'label',
        'description',
        'downloadBytes',
        'installed',
        'source',
        'recommended',
        'license',
        'licenseUrl',
      ],
      ['updateRequired', 'sharedStorage'],
    )
  ) {
    return null;
  }
  const kind = parseSpeechModelKind(value.kind);
  if (!isSpeechModelId(value.id) || !kind) return null;
  if (!isLabel(value.label) || !isLabel(value.description) || !isLabel(value.license)) return null;
  if (!isNonNegativeInteger(value.downloadBytes, SPEECH_WIRE_LIMITS.downloadBytesCeiling))
    return null;
  if (typeof value.installed !== 'boolean' || typeof value.recommended !== 'boolean') return null;
  if (value.sharedStorage !== undefined && typeof value.sharedStorage !== 'boolean') return null;
  if (value.source !== 'app' && value.source !== 'shared' && value.source !== null) return null;
  if (value.installed !== (value.source !== null)) return null;
  if (value.sharedStorage === true && value.source !== 'app') return null;
  if ('updateRequired' in value && typeof value.updateRequired !== 'boolean') return null;
  if (value.updateRequired === true && value.installed) return null;
  if (!parseHttpsUrl(value.licenseUrl)) return null;
  return {
    id: value.id,
    kind,
    label: value.label,
    description: value.description,
    downloadBytes: value.downloadBytes,
    installed: value.installed,
    ...(typeof value.updateRequired === 'boolean' ? { updateRequired: value.updateRequired } : {}),
    source: value.source,
    ...(value.sharedStorage !== undefined ? { sharedStorage: value.sharedStorage } : {}),
    recommended: value.recommended,
    license: value.license,
    licenseUrl: value.licenseUrl as string,
  };
}

export function parseSpeechVoiceInfo(value: unknown): SpeechVoiceInfo | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['id', 'label', 'language', 'gender', 'modelId'])) return null;
  if (!isSpeechModelId(value.id) || !isSpeechModelId(value.modelId)) return null;
  if (!isLabel(value.label)) return null;
  if (typeof value.language !== 'string' || !LANGUAGE_TAG.test(value.language)) return null;
  if (value.gender !== 'female' && value.gender !== 'male' && value.gender !== null) return null;
  return {
    id: value.id,
    label: value.label,
    language: value.language,
    gender: value.gender,
    modelId: value.modelId,
  };
}

export function parseSpeechCatalog(value: unknown): SpeechCatalog | null {
  if (!isRecord(value) || !hasExactKeys(value, ['models', 'voices'])) return null;
  if (!Array.isArray(value.models) || value.models.length > SPEECH_WIRE_LIMITS.modelEntries)
    return null;
  if (!Array.isArray(value.voices) || value.voices.length > SPEECH_WIRE_LIMITS.voiceEntries)
    return null;
  const models: SpeechModelInfo[] = [];
  for (const entry of value.models) {
    const model = parseSpeechModelInfo(entry);
    if (!model) return null;
    models.push(model);
  }
  const voices: SpeechVoiceInfo[] = [];
  for (const entry of value.voices) {
    const voice = parseSpeechVoiceInfo(entry);
    if (!voice) return null;
    voices.push(voice);
  }
  return { models, voices };
}

export function parseSpeechProgress(value: unknown): SpeechProgress | null {
  if (!isRecord(value) || !hasExactKeys(value, ['phase', 'receivedBytes', 'totalBytes']))
    return null;
  if (value.phase !== 'downloading' && value.phase !== 'verifying') return null;
  if (!isNonNegativeInteger(value.receivedBytes, SPEECH_WIRE_LIMITS.downloadBytesCeiling))
    return null;
  if (
    value.totalBytes !== null &&
    !isNonNegativeInteger(value.totalBytes, SPEECH_WIRE_LIMITS.downloadBytesCeiling)
  ) {
    return null;
  }
  return {
    phase: value.phase,
    receivedBytes: value.receivedBytes,
    totalBytes: value.totalBytes as number | null,
  };
}

export function parseSpeechInstallEvent(value: unknown): SpeechInstallEvent | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'progress' && hasExactKeys(value, ['kind', 'progress'])) {
    const progress = parseSpeechProgress(value.progress);
    return progress ? { kind: 'progress', progress } : null;
  }
  if (value.kind === 'done' && hasExactKeys(value, ['kind', 'model'])) {
    const model = parseSpeechModelInfo(value.model);
    return model ? { kind: 'done', model } : null;
  }
  if (value.kind === 'error' && hasExactKeys(value, ['kind', 'error'])) {
    const error = parseSpeechError(value.error);
    return error ? { kind: 'error', error } : null;
  }
  return null;
}

export function parseSpeechPreferences(value: unknown): SpeechPreferences | null {
  if (!isRecord(value) || !hasExactKeys(value, ['sttModel', 'voice', 'speed'])) return null;
  const patch = parseSpeechPreferencesPatch(value);
  if (!patch || patch.speed === undefined) return null;
  return {
    sttModel: patch.sttModel ?? null,
    voice: patch.voice ?? null,
    speed: patch.speed,
  };
}

function parseSpeechSegment(value: unknown): SpeechSegment | null {
  if (!isRecord(value) || !hasExactKeys(value, ['start', 'end', 'text'])) return null;
  if (!isFiniteInRange(value.start, 0, SPEECH_WIRE_LIMITS.durationCeiling)) return null;
  if (!isFiniteInRange(value.end, value.start, SPEECH_WIRE_LIMITS.durationCeiling)) return null;
  if (!isBoundedString(value.text, SPEECH_WIRE_LIMITS.transcriptCharacters)) return null;
  return { start: value.start, end: value.end, text: value.text };
}

export function parseSpeechTranscript(value: unknown): SpeechTranscript | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['text', 'language', 'segments', 'durationMs'])) return null;
  if (!isBoundedString(value.text, SPEECH_WIRE_LIMITS.transcriptCharacters)) return null;
  if (
    value.language !== null &&
    (typeof value.language !== 'string' || !LANGUAGE_TAG.test(value.language))
  ) {
    return null;
  }
  if (!Array.isArray(value.segments) || value.segments.length > SPEECH_WIRE_LIMITS.segmentEntries)
    return null;
  if (!isFiniteInRange(value.durationMs, 0, SPEECH_WIRE_LIMITS.durationCeiling * 1000)) return null;
  const segments: SpeechSegment[] = [];
  for (const entry of value.segments) {
    const segment = parseSpeechSegment(entry);
    if (!segment) return null;
    segments.push(segment);
  }
  return {
    text: value.text,
    language: value.language as string | null,
    segments,
    durationMs: value.durationMs,
  };
}

export function parseSpeechAudioChunk(value: unknown): SpeechAudioChunk | null {
  if (!isRecord(value)) return null;
  if (
    !hasKeysWithin(
      value,
      ['index', 'pcm', 'sampleRate', 'durationSec', 'textStart', 'textEnd'],
      ['wordTimings'],
    )
  ) {
    return null;
  }
  if (!isNonNegativeInteger(value.index, Number.MAX_SAFE_INTEGER)) return null;
  const pcm = ownedBuffer(value.pcm, SPEECH_WIRE_LIMITS.chunkPcmBytes);
  if (!pcm || pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
  if (
    !isNonNegativeInteger(value.sampleRate, SPEECH_WIRE_LIMITS.maxSampleRate) ||
    value.sampleRate < SPEECH_WIRE_LIMITS.minSampleRate
  ) {
    return null;
  }
  if (!isFiniteInRange(value.durationSec, 0, SPEECH_WIRE_LIMITS.durationCeiling)) return null;
  const textCeiling = SPEECH_WIRE_LIMITS.synthesizeTextCharacters;
  if (!isNonNegativeInteger(value.textStart, textCeiling)) return null;
  if (!isNonNegativeInteger(value.textEnd, textCeiling) || value.textEnd < value.textStart)
    return null;
  const wordTimings: SpeechWordTiming[] = [];
  if ('wordTimings' in value) {
    if (
      !Array.isArray(value.wordTimings) ||
      value.wordTimings.length > SPEECH_WIRE_LIMITS.chunkWordEntries
    )
      return null;
    let previousEnd = 0;
    let previousTextStart = value.textStart;
    let previousTextEnd = value.textStart;
    for (const word of value.wordTimings) {
      if (!isRecord(word) || !hasExactKeys(word, ['textStart', 'textEnd', 'startSec', 'endSec']))
        return null;
      if (
        !isNonNegativeInteger(word.textStart, value.textEnd) ||
        word.textStart < previousTextStart
      )
        return null;
      if (
        !isNonNegativeInteger(word.textEnd, value.textEnd) ||
        word.textEnd <= word.textStart ||
        word.textEnd < previousTextEnd
      )
        return null;
      if (
        !isFiniteInRange(word.startSec, previousEnd, value.durationSec) ||
        !isFiniteInRange(word.endSec, word.startSec, value.durationSec) ||
        word.endSec === word.startSec
      )
        return null;
      wordTimings.push({
        textStart: word.textStart,
        textEnd: word.textEnd,
        startSec: word.startSec,
        endSec: word.endSec,
      });
      previousEnd = word.endSec;
      previousTextStart = word.textStart;
      previousTextEnd = word.textEnd;
    }
  }
  return {
    index: value.index,
    pcm,
    sampleRate: value.sampleRate,
    durationSec: value.durationSec,
    textStart: value.textStart,
    textEnd: value.textEnd,
    ...('wordTimings' in value ? { wordTimings } : {}),
  };
}

export function parseSpeechSynthesisSummary(value: unknown): SpeechSynthesisSummary | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['voice', 'model', 'sampleRate', 'durationSec', 'chunks'])) return null;
  if (!isSpeechModelId(value.voice) || !isSpeechModelId(value.model)) return null;
  if (
    !isNonNegativeInteger(value.sampleRate, SPEECH_WIRE_LIMITS.maxSampleRate) ||
    value.sampleRate < SPEECH_WIRE_LIMITS.minSampleRate
  ) {
    return null;
  }
  if (!isFiniteInRange(value.durationSec, 0, SPEECH_WIRE_LIMITS.durationCeiling * 24)) return null;
  if (!isNonNegativeInteger(value.chunks, Number.MAX_SAFE_INTEGER)) return null;
  return {
    voice: value.voice,
    model: value.model,
    sampleRate: value.sampleRate,
    durationSec: value.durationSec,
    chunks: value.chunks,
  };
}

export function parseSpeechSynthesizeEvent(value: unknown): SpeechSynthesizeEvent | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === 'progress' &&
    hasExactKeys(value, ['kind', 'phase', 'completedCharacters', 'totalCharacters'])
  ) {
    if (value.phase !== 'loading' && value.phase !== 'synthesizing') return null;
    const ceiling = SPEECH_WIRE_LIMITS.synthesizeTextCharacters;
    if (!isNonNegativeInteger(value.totalCharacters, ceiling)) return null;
    if (!isNonNegativeInteger(value.completedCharacters, value.totalCharacters)) return null;
    return {
      kind: 'progress',
      phase: value.phase,
      completedCharacters: value.completedCharacters,
      totalCharacters: value.totalCharacters,
    };
  }
  if (value.kind === 'chunk' && hasExactKeys(value, ['kind', 'chunk'])) {
    const chunk = parseSpeechAudioChunk(value.chunk);
    return chunk ? { kind: 'chunk', chunk } : null;
  }
  if (value.kind === 'done' && hasExactKeys(value, ['kind', 'summary'])) {
    const summary = parseSpeechSynthesisSummary(value.summary);
    return summary ? { kind: 'done', summary } : null;
  }
  if (value.kind === 'error' && hasExactKeys(value, ['kind', 'error'])) {
    const error = parseSpeechError(value.error);
    return error ? { kind: 'error', error } : null;
  }
  return null;
}
