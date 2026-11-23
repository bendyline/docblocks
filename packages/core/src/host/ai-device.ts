/**
 * ai-device — whether a device is worth suggesting AI on.
 *
 * DocBlocks keeps AI out of the way unless the device can run a model at
 * least as good as Gemma 4 E4B, and run it well: an Apple-silicon Mac with
 * 16 GB of memory, a PC with an 8 GB graphics card, or one of the top phones
 * and tablets with 12 GB. Those are Gezel's own lines between a constrained
 * machine and one that runs its recommended models well
 * (`CONSTRAINED_HOST_RAM_BYTES`, `CONSTRAINED_HOST_VRAM_BYTES`). A browser has
 * no local model, and a PC that would run one on its processor alone runs it
 * too slowly to be worth suggesting.
 *
 * Hosts measure the memory cheaply and without starting a provider, so the
 * question can be asked while AI is off, which is the only time it matters.
 */

/** Where a local model's weights would live. */
export type AiDeviceMemory =
  /** One pool the processor and graphics share: Apple silicon, NVIDIA GB10. */
  | 'unified'
  /** A graphics card's own memory. */
  | 'gpu'
  /** A phone or tablet's memory. */
  | 'mobile'
  /** System memory alone: no graphics memory a model can use. */
  | 'system';

export interface AiDeviceFit {
  readonly memory: AiDeviceMemory;
  /** That memory's size in bytes; null when it could not be measured. */
  readonly bytes: number | null;
  /** Worth suggesting AI here. */
  readonly suggestAi: boolean;
}

const GIB = 1024 ** 3;

/**
 * The least memory of each kind worth suggesting AI on. Each sits a little
 * under the size the device is sold with: a 16 GB Mac reports exactly 16 GiB,
 * an 8 GB card a few MiB under 8, and a 12 GB phone keeps part for the system.
 * Null: never suggested.
 */
export const AI_SUGGESTION_MIN_BYTES: Readonly<Record<AiDeviceMemory, number | null>> = {
  unified: 15.5 * GIB,
  gpu: 7.5 * GIB,
  mobile: 10.5 * GIB,
  system: null,
};

const AI_DEVICE_MEMORIES: ReadonlySet<string> = new Set<AiDeviceMemory>([
  'unified',
  'gpu',
  'mobile',
  'system',
]);

/** Whether `bytes` of `memory` can run a model worth suggesting AI for. */
export function suggestsLocalAi(memory: AiDeviceMemory, bytes: number | null): boolean {
  const least = AI_SUGGESTION_MIN_BYTES[memory];
  return least !== null && bytes !== null && Number.isFinite(bytes) && bytes >= least;
}

/** A device's fit, with the verdict worked out from its memory. */
export function aiDeviceFit(memory: AiDeviceMemory, bytes: number | null): AiDeviceFit {
  return { memory, bytes, suggestAi: suggestsLocalAi(memory, bytes) };
}

/**
 * A device fit that crossed a process boundary, or null when it is not one.
 * The verdict is worked out again here rather than taken from the wire.
 */
export function parseAiDeviceFit(value: unknown): AiDeviceFit | null {
  if (typeof value !== 'object' || value === null) return null;
  const { memory, bytes } = value as Record<string, unknown>;
  if (typeof memory !== 'string' || !AI_DEVICE_MEMORIES.has(memory)) return null;
  if (bytes !== null && (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0)) {
    return null;
  }
  return aiDeviceFit(memory as AiDeviceMemory, bytes);
}
