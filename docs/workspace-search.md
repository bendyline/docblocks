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
engine for the session. A worker waits up to 1.5 s for its workspace's Web
Lock, so the index reopening in the same window keeps its store.

**Privacy and storage.** The store is a copy of the workspace's text in the
app's origin-private storage, never in the workspace. Settings → Search →
Search index has a per-workspace "Keep a search index for this workspace"
(on by default; off deletes the stored copy and indexes in memory each
session) and "Clear search index" (deletes the store and rebuilds it, vectors
included). Both go through the open request's `discard` flag, which only a
worker holding the workspace's lock acts on. The desktop permission policy
grants `persistent-storage`, so Chromium does not evict the store under disk
pressure; phones answer `persist()` with false and the index rebuilds after an
eviction.

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
- **Listing.** Providers with `enumerate` list metadata only, without hashing
  or touching online-only cloud files. Desktop walks in main; on phones the
  bridge walks one folder per native `listMetadata` call (iOS `Storage.swift`,
  Android `Storage.java`), so a phone no longer hashes the workspace (and no
  longer fails on a folder holding over 32 MB) to index it. Others walk
  `readDirectory`.
- **Large workspaces (desktop).** The watcher's starting baseline is a
  metadata walk bounded like `enumerate` (1,000,000 entries), not a hashing
  scan capped at the 10,000-entry wire limit. One folder listing may carry
  100,000 children (`FILE_SYSTEM_DIRECTORY_LIMITS`), for flat notes folders.
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

## AI answers from the workspace

- **Grounded actions.** Every AI action that searches knowledge (it sets
  `knowledgeQuery`) also carries up to six passages from the open workspace,
  found by meaning and leaving out the open note (`withWorkspaceGrounding` in
  `packages/react/src/Ai/workspace-grounding.ts`). Only passages the vector arm
  found above the profile's floor are offered, the bar Gezel holds unjudged
  catalog passages to; a search that takes over 1.2 s offers none.
- **Citations.** A workspace passage is cited as
  `knowledge://local/<ws-hash>/<path>#line=a-b` (`workspacePassageUri` in
  core), in the grammar Gezel accepts for an app's own passages: NFC, at most
  256 characters, no control characters or empty segments. A note whose path
  the grammar cannot name is not offered. `parseWorkspacePassageUri` reads one
  back. Evidence on the `knowledge` chat event carries each passage's `uri`.
- **Ranking.** Hosts hand the passages to Gezel's `knowledgeContext`, beside
  the enabled catalogs (`withWorkspacePassages` in core). Today the two take
  turns, a catalog passage first. Gezel's retrieve route can also take them as
  `candidates` and judge both with its relevance model; DocBlocks moves to that
  once the release with it is pinned.
- **Footnotes.** An inserted draft names a cited note in a footnote that links
  it relative to the document: `[^source-1]: [Rose bed](garden/roses.md), a
note in this workspace.`
- **Ask your workspace** (AI menu, where the host can search by meaning): a
  side-panel conversation. Each question finds passages across the whole
  workspace (4 s budget), sends them with the last three finished turns, and
  checks the answer's details against them where the host has a fact check. A
  question that matches no note never reaches the model. Citations are chips
  that open the note with Find on the passage; the indicator lists each note
  with its lines. Answers can be inserted into the document or saved as a new
  note, both with footnotes. The conversation belongs to the shell, so it
  survives opening a cited note, and starts afresh with another workspace. The
  panel explains what stops a question: search by meaning off, the model
  missing, or the workspace switched off for AI answers.
- **Switch.** Settings → Search → "Use this workspace in AI answers", per
  workspace: on by default for an on-device provider, off for a remote one.

## Testing

- Unit: `packages/core/test/workspace-index*.test.ts`,
  `packages/react/test/{live-index-engine,workspace-index-worker,embedding-scheduler,host-embedder}.test.ts`,
  `packages/desktop/test/embedding-engine.test.ts`.
- AI answers: `packages/core/test/ai-workspace-knowledge.test.ts`,
  `packages/react/test/{workspace-grounding,workspace-ask,ai-ask-panel,ai-knowledge-indicator,knowledge-citations}.test.ts`;
  desktop e2e in `packages/desktop/e2e/ai-editor.spec.ts`.
- Desktop e2e: `packages/desktop/e2e/workspace-index.spec.ts`. Every e2e run
  uses a stand-in embedding utility (`e2e/fake-embedding-utility.cjs`) with
  deterministic vectors; launch with `DOCBLOCKS_EMBEDDINGS_ENTRY=''` to use the
  real model in a source build.
- Scale: `npm run bench:index -- --sizes 5000,50000` writes a report to `reports/`.
