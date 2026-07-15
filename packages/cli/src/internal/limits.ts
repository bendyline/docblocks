/**
 * Resolve a caller-supplied numeric budget against its safe default.
 *
 * `label` describes the budget in full (for example `build entry` or
 * `conversion input byte`) and is interpolated into the rejection message.
 */
export function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`Invalid ${label} limit.`);
  }
  return selected;
}
