import type { ProofingProvider } from '@bendyline/squisq-editor-react';

export interface DeferredProofingProviderOptions {
  /**
   * Build the real provider. Called on the first operation that needs the
   * engine, never at construction, so a document with proofing switched off
   * downloads nothing. A rejection is not cached: the next call retries.
   */
  create(): Promise<ProofingProvider>;
  /** Reported synchronously, before the real provider exists. */
  hasAppDictionary: boolean;
  /** Release whatever `create` depended on, once the provider is disposed. */
  onDispose?(): void;
}

/**
 * A {@link ProofingProvider} whose engine wiring is only known asynchronously.
 *
 * Squisq takes its engine location as a plain URL when the provider is built,
 * but the VS Code webview can only produce a URL the engine worker is able to
 * read after downloading the binary (see `proofingEngineSource.ts`). Squisq
 * already loads its engine lazily, on the first `setup` or `lint`; this keeps
 * that contract by deferring the whole provider to the same moment and
 * forwarding every call to it.
 */
export function createDeferredProofingProvider(
  options: DeferredProofingProviderOptions,
): ProofingProvider {
  let inner: Promise<ProofingProvider> | null = null;
  let built: ProofingProvider | null = null;
  let disposed = false;

  function provider(): Promise<ProofingProvider> {
    if (disposed) return Promise.reject(new Error('ProofingProvider has been disposed'));
    if (!inner) {
      const created = options.create();
      inner = created;
      created.then(
        (value) => {
          // Disposed while the engine was still being wired: `dispose` had
          // nothing to release, so release it here instead.
          if (disposed) value.dispose();
          else built = value;
        },
        () => {
          if (inner === created) inner = null;
        },
      );
    }
    return inner;
  }

  return {
    hasAppDictionary: options.hasAppDictionary,
    async setup() {
      await (await provider()).setup();
    },
    async lint(text, lintOptions) {
      return (await provider()).lint(text, lintOptions);
    },
    async ignoreFinding(findingId) {
      await (await provider()).ignoreFinding(findingId);
    },
    async addWord(word) {
      await (await provider()).addWord(word);
    },
    async addWords(words) {
      // Squisq's own provider returns early here without loading the engine;
      // building it for an empty list would download the binary for nothing.
      if (words.length === 0) return;
      await (await provider()).addWords(words);
    },
    async exportIgnored() {
      return (await provider()).exportIgnored();
    },
    async importIgnored(json) {
      await (await provider()).importIgnored(json);
    },
    async clearIgnored() {
      await (await provider()).clearIgnored();
    },
    async setDialect(dialect) {
      await (await provider()).setDialect(dialect);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      inner = null;
      built?.dispose();
      built = null;
      options.onDispose?.();
    },
  };
}
