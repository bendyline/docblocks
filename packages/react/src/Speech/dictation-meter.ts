/**
 * The rolling microphone meter Squisq draws in the editor's dictation button,
 * kept here for the dictation buttons DocBlocks draws itself (Quick Jot).
 * Same bar count and the same scaling, so both read alike.
 */

/** Bars in a dictation meter, oldest first. */
export const DICTATION_METER_BARS = 12;

/** A meter with nothing heard yet. */
export const SILENT_METER: readonly number[] = Object.freeze(
  Array.from({ length: DICTATION_METER_BARS }, () => 0),
);

/** Map a microphone RMS level (speech sits well under 0.1) onto a legible 0–1 bar. */
export function meterLevel(rms: number): number {
  return Math.min(1, Math.max(0, rms * 14));
}

/** The meter after one more level: drops the oldest bar, adds the newest. */
export function pushMeterLevel(levels: readonly number[], rms: number): readonly number[] {
  return [...levels.slice(1 - DICTATION_METER_BARS), meterLevel(rms)];
}
