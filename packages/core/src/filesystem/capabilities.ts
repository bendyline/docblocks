import type { FileSystemProviderCapabilities } from './v2.js';

/** Capabilities cross the native boundary and must describe the actual backend. */
export function parseFileSystemCapabilities(value: unknown): FileSystemProviderCapabilities {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid filesystem capabilities.');
  }
  const record = value as Record<string, unknown>;
  const choices = {
    writeAtomicity: ['none', 'process', 'cross-context'],
    moveAtomicity: ['none', 'process', 'cross-context'],
    snapshotAtomicity: ['none', 'process', 'cross-context'],
    conditionalWrite: ['none', 'process', 'cross-context', 'storage-atomic'],
    recursiveRemove: [true, false],
    watch: [true, false],
    caseSensitivity: ['sensitive', 'insensitive', 'platform'],
    symlinkPolicy: ['unsupported', 'reject', 'follow-contained', 'preserve'],
    durability: ['volatile', 'best-effort', 'durable'],
  } satisfies Record<keyof FileSystemProviderCapabilities, readonly unknown[]>;
  if (Object.keys(record).length !== Object.keys(choices).length) {
    throw new TypeError('Unexpected filesystem capability fields.');
  }
  for (const [key, values] of Object.entries(choices)) {
    if (!(values as readonly unknown[]).includes(record[key])) {
      throw new TypeError(`Invalid filesystem capability: ${key}.`);
    }
  }
  return Object.freeze({ ...record }) as unknown as FileSystemProviderCapabilities;
}
