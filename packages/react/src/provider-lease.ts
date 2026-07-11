import type { FileSystemProviderV2 } from '@bendyline/docblocks/filesystem';

interface ProviderLeaseRecord {
  holders: number;
  generation: number;
  disposePromise: Promise<void> | null;
}

const leases = new WeakMap<FileSystemProviderV2, ProviderLeaseRecord>();

/**
 * Retain one UI ownership lease for a provider.
 *
 * Final release is deferred by one microtask. React Strict Mode intentionally
 * performs setup → cleanup → setup, so an immediate cleanup disposer would
 * permanently close the provider that the second setup still owns.
 */
export function retainFileSystemProvider(provider: FileSystemProviderV2): () => void {
  let record = leases.get(provider);
  if (!record) {
    record = { holders: 0, generation: 0, disposePromise: null };
    leases.set(provider, record);
  }
  if (record.disposePromise) {
    throw new Error('Cannot retain a filesystem provider after disposal has started.');
  }

  record.holders += 1;
  record.generation += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record!.holders -= 1;
    record!.generation += 1;
    const releaseGeneration = record!.generation;
    queueMicrotask(() => {
      if (
        record!.holders !== 0 ||
        record!.generation !== releaseGeneration ||
        record!.disposePromise
      ) {
        return;
      }
      record!.disposePromise = provider.dispose();
      // React cleanup cannot await or render a disposal failure. Joiners still
      // receive the original promise from the provider; this observer prevents
      // an unhandled rejection during unmount.
      void record!.disposePromise.catch(() => undefined);
    });
  };
}
