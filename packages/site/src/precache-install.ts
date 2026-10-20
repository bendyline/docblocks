/** Bounded parallelism avoids serial network latency without flooding the
 * browser with hundreds of requests (Workbox issue #2528). Failed entries
 * get one retry; any remaining failure prevents installation from succeeding.
 */
export async function installOfflineAssets<T>(
  entries: readonly T[],
  cacheEntry: (entry: T) => Promise<void>,
  concurrency = 4,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('Offline install concurrency must be between 1 and 8.');
  }
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure && next < entries.length) {
      const entry = entries[next++];
      try {
        await cacheEntry(entry);
      } catch {
        try {
          await cacheEntry(entry);
        } catch (error) {
          failure = { error };
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  if (failure) throw failure.error;
}
