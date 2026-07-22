let monacoWorkersPromise: Promise<unknown> | null = null;
let monacoRuntimePromise: Promise<unknown> | null = null;

/** Configure worker constructors without fetching any worker implementation. */
export function ensureMonacoWorkers(): Promise<unknown> {
  monacoWorkersPromise ??= import('./setupMonacoWorkers.js').catch((error: unknown) => {
    monacoWorkersPromise = null;
    throw error;
  });
  return monacoWorkersPromise;
}

/**
 * Start Monaco's canonical Squisq-owned import before a known consumer mounts.
 * The editor hook later reuses the evaluated module and performs its normal
 * loader configuration.
 */
export function preloadMonacoRuntime(): Promise<unknown> {
  monacoRuntimePromise ??= Promise.all([
    import('@bendyline/squisq-editor-react/monaco'),
    // Worker setup is an enhancement and must not make Monaco unavailable.
    ensureMonacoWorkers().catch(() => undefined),
  ])
    .then(([monaco]) => monaco)
    .catch((error: unknown) => {
      monacoRuntimePromise = null;
      throw error;
    });
  return monacoRuntimePromise;
}
