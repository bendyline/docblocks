/// <reference types="vite/client" />

declare const __DOCBLOCKS_VERSION__: string;
declare const __DOCBLOCKS_BUILD_DATE__: string;

declare module 'virtual:docblocks-kokoro-lexicon' {
  /** Gzipped Kokoro dictionaries for American and British voices. */
  export const kokoroLexiconUrls: { readonly us: string; readonly gb: string };
}

declare module 'virtual:docblocks-gezel-knowledge' {
  /** The knowledge worker and SQLite's WebAssembly, served beside the app. */
  export const gezelKnowledgeUrls: { readonly workerUrl: string; readonly wasmUrl: string };
}
