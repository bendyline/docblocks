/** A model download size the way Settings shows it. */
export function formatModelSize(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  if (gigabytes >= 0.95) return `${gigabytes.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
