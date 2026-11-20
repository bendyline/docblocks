# Workspace search

How DocBlocks indexes a workspace, searches it, and ranks it by meaning. The
same index feeds quick-open, the link picker and the search panel.

## Surfaces

| Surface       | Engine                                          | Survives relaunch    | Best matches | Semantic search                |
| ------------- | ----------------------------------------------- | -------------------- | ------------ | ------------------------------ |
| Desktop       | Worker + SQLite (origin-private `opfs-sahpool`) | Yes                  | Yes          | Bundled model, on by default   |
| iOS / Android | Worker + SQLite (origin-private `opfs-sahpool`) | Yes (may be evicted) | Yes          | Gezel's model, downloaded once |
| Site, VS Code | In memory, on the page                          | No                   | No           | No                             |

A second window on the same workspace, a transient workspace (a loose file,
an opened bundle), or a store that will not open falls back to the in-memory
engine for the session.

## Pieces

```
page (main thread)                       index worker                       host
──────────────────                       ────────────                       ────
createWorkspaceIndex (core)        ──▶   serveWorkspaceIndexEngine (core)   host.embeddings
  lists via provider.enumerate             Gezel LiveIndex over sqlite-wasm   desktop: utility process
  reads changed files only                 parse + search text (core)          running Gezel's embedder
  names for quick-open                     FTS5 BM25, vectors, fusion        phones: GezelKnowledge
startEmbeddingScheduler (react) ◀────▶   pendingEmbeddings / storeEmbeddings  native embed
```

- **Engine seam.** `WorkspaceIndexEngine` (`packages/core/src/workspace-index/engine.ts`):
  `restore`, `analyze`, `forget`, `search`, and optionally `find` (ranked
  passages). `createMemoryEngine` is the default; `createWorkerEngine` talks to
  a worker; `withMemoryFallback` switches to memory if the worker fails.
- **Worker entry.** `@bendyline/docblocks-react/workspace-index-worker`
  (`startWorkspaceIndexWorker`). It holds a Web Lock per workspace and opens
  that workspace's own SQLite pool. Apps start it from a two-line worker file
  and pass it to the shell as `workspaceIndexWorker`.
- **Listing.** Providers with `enumerate` (desktop) list metadata only, without
  hashing or touching online-only cloud files. Others walk `readDirectory`.
- **Relaunch.** The store returns each document's version; only documents
  whose version changed are read again.
- **Literal search** keeps exact semantics (case, whole word) by scanning the
  stored, line-mapped search text. **Best matches** is BM25 over titles (5),
  headings (2) and text (1), fused with the vector arm when semantic search is
  on (reciprocal rank fusion, k = 60). Vectors below the profile's measured
  floor are dropped.

## Semantic search

- **Profile.** `bge-small-en-v1.5@1` (384 dimensions, English). The vectors, the
  chunking (`markdown-chunks@2`, 420/64 tokens counted with the model's own
  tokenizer) and the embed input come from Gezel, so they match its catalogs.
- **Desktop model.** Pinned in `packages/desktop/embedding-model.json` (Gezel's
  revision and digests; `check:desktop-config` asserts they match).
  `npm run stage:embedding-model` stages it into `dist/embedding-model/`
  (copying from a local Hugging Face cache when the digests match); packaging
  stages it in `beforePack` and ships it in `resources/embedding-model/` with
  its MIT license. It never downloads at runtime.
- **Phone model.** The same model the knowledge catalogs use, installed into
  the knowledge plugin's store; Settings → Search offers the download.
- **Scheduling.** `startEmbeddingScheduler` embeds in batches of 16 while the
  page is visible and the switch is on, backs off when the embedder fails, and
  sleeps until the index changes. Vectors are keyed by a hash of the exact
  embed input, so renamed files and unchanged passages are never re-embedded.
- **Queries** get 1.5 s to embed; past that, or when the embedder fails, the
  search runs on words alone.
- **The switch** (Settings → Search → "Search by meaning") pauses embedding and
  meaning-ranked queries; stored vectors are kept.

## Testing

- Unit: `packages/core/test/workspace-index*.test.ts`,
  `packages/react/test/{live-index-engine,workspace-index-worker,embedding-scheduler,host-embedder}.test.ts`,
  `packages/desktop/test/embedding-engine.test.ts`.
- Desktop e2e: `packages/desktop/e2e/workspace-index.spec.ts`. Every e2e run
  uses a stand-in embedding utility (`e2e/fake-embedding-utility.cjs`) with
  deterministic vectors; launch with `DOCBLOCKS_EMBEDDINGS_ENTRY=''` to use the
  real model in a source build.
- Scale: `npm run bench:index -- --sizes 5000,50000` writes a report to `reports/`.
