type LockNavigator = Navigator & {
  locks?: {
    request<T>(name: string, callback: () => Promise<T>): Promise<T>;
  };
};

const localTails = new Map<string, Promise<void>>();

/** Serialize conditional commits across providers and, when available, tabs. */
export async function withFileCommitLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const lockManager =
    typeof navigator === 'undefined' ? undefined : (navigator as LockNavigator).locks;
  if (lockManager) {
    return lockManager.request(`docblocks:${key}`, operation);
  }

  const previous = localTails.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  localTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (localTails.get(key) === tail) localTails.delete(key);
  }
}
