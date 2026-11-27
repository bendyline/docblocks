/**
 * How much memory this computer has for a local model, measured without
 * starting the AI provider, so DocBlocks can decide whether to suggest AI
 * while it is still off (core `ai-device.ts` holds the rule).
 *
 * A Mac answers at once: Apple silicon shares its memory with the graphics,
 * so its size is the answer. Windows and Linux ask Gezel's own probe, the
 * one its model recommendations rest on: `nvidia-smi` for an NVIDIA card,
 * otherwise the bundled engine's device list, which tells a graphics card
 * from integrated graphics. That can take a couple of seconds while a card
 * wakes, so it runs once, when first asked, and the answer is kept.
 */

import os from 'node:os';
import { aiDeviceFit, type AiDeviceFit, type AiDeviceMemory } from '@bendyline/docblocks/host';

/** The part of Gezel's memory profile this needs. */
export interface DeviceMemoryProfile {
  readonly totalRamBytes: number;
  readonly gpuVramBytes: number | null;
  readonly gpuMemoryKind: string;
}

export interface AiDeviceProbeOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  totalMemoryBytes?: () => number;
  /** Gezel's probe; loaded lazily, and only off the Mac. */
  detectMemoryProfile?: () => Promise<DeviceMemoryProfile>;
}

async function gezelMemoryProfile(): Promise<DeviceMemoryProfile> {
  const { detectMemoryProfile } = await import('@bendyline/gezel-inference/internal/system/memory');
  return detectMemoryProfile();
}

async function measure(options: AiDeviceProbeOptions): Promise<AiDeviceFit> {
  const platform = options.platform ?? process.platform;
  const totalMemoryBytes = options.totalMemoryBytes ?? (() => os.totalmem());
  if (platform === 'darwin') {
    // Intel Macs have no unified memory and no supported local engine.
    const arch = options.arch ?? process.arch;
    return aiDeviceFit(arch === 'arm64' ? 'unified' : 'system', totalMemoryBytes());
  }
  const profile = await (options.detectMemoryProfile ?? gezelMemoryProfile)();
  const vram = profile.gpuVramBytes;
  if (vram !== null && profile.gpuMemoryKind === 'discrete') return aiDeviceFit('gpu', vram);
  // NVIDIA GB10 and its kind report one shared pool through the card.
  if (vram !== null && profile.gpuMemoryKind === 'unified') return aiDeviceFit('unified', vram);
  return aiDeviceFit('system', profile.totalRamBytes);
}

/**
 * A probe that measures once, on first use, and answers from then on. A
 * probe that fails reports system memory, which is never suggested: an
 * unmeasured machine is left alone.
 */
export function createAiDeviceProbe(
  options: AiDeviceProbeOptions = {},
): () => Promise<AiDeviceFit> {
  let measured: Promise<AiDeviceFit> | null = null;
  return () => {
    measured ??= measure(options).catch(() => aiDeviceFit('system', null));
    return measured;
  };
}

const AUTOMATION_DEVICE = /^(unified|gpu|mobile|system):(\d+(?:\.\d+)?)$/u;

/**
 * The device automated runs see, so a suite behaves the same on every test
 * machine: whatever `DOCBLOCKS_E2E_AI_DEVICE` names, as memory and GiB
 * (`unified:32`, `gpu:8`), else a machine AI is not suggested on.
 */
export function automationDeviceFit(value: string | undefined): AiDeviceFit {
  const match = AUTOMATION_DEVICE.exec(value?.trim() ?? '');
  if (!match) return aiDeviceFit('system', null);
  return aiDeviceFit(match[1] as AiDeviceMemory, Number(match[2]) * 1024 ** 3);
}
