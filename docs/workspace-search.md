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
  catalog passages to, and only those within 0.08 of the best one
  (`WORKSPACE_GROUNDING_MARGIN`; see Retrieval quality). A search that takes
  over 1.2 s offers none.
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

## Retrieval quality

`npm run eval:workspace-retrieval` scores search over a judged corpus in
`packages/bench/fixtures/workspace-retrieval/`: 84 invented personal notes
(home, work, study; 36k words, 574 passages) and 78 queries of four kinds:
_lexical_ (shares the note's words), _paraphrase_ (shares none), _detail_ (one
fact buried in a long note), and _none_ (nothing in the workspace answers it).
Each answer is quoted verbatim, so a passage is scored on holding it, not just
on coming from the right note. The eval runs the product's own code: the live
engine with token chunking, Gezel's profile embedder on the bundled model, and
`findWorkspacePassages`. It needs the staged model; `--quantized` swaps in the
34 MB int8 graph. Reports go to `reports/workspace-retrieval-evals/`.
`packages/bench/test/workspace-retrieval.test.ts` checks the fixture and holds
search by words to its measured level in `npm test`.

Measured 2026-11-21 (M5 Max):

| Answerable queries (69)  | Note first | Note in top 5 | nDCG@10 | Answer passage in top 5 |
| ------------------------ | ---------: | ------------: | ------: | ----------------------: |
| Words only (no model)    |        74% |           88% |   0.812 |                     65% |
| Best matches (hybrid)    |        86% |           96% |   0.907 |                     83% |
| Meaning only, no floor   |        91% |           97% |   0.943 |                     88% |
| Best matches, int8 model |        87% |           96% |   0.915 |                     84% |

Paraphrase queries are where meaning earns its place: words alone put the
right note first 43% of the time, Best matches 70%.

**The vector floor (spike S4).** `bge-small-en-v1.5@1`'s floor of 0.55 holds as
the gate for questions the workspace cannot answer: none of the nine reaches it
(their best passages score 0.488–0.544, a thin margin). It is a poor gate
within answerable questions: answer passages score 0.48–0.84 (median 0.68),
11 of 69 fall below 0.55, and the best unrelated passage clears it for 44 of
78 queries. Ranking is unaffected (a lower floor for Best matches gains
nothing), but grounding sent passages from unrelated notes 44% of the time.
Keeping only passages within 0.08 of the best one sends the same answers (49
of 69 questions get the passage that answers them), cuts unrelated passages to
24% of those sent, and sends 43% fewer passages. The int8 graph scores on the
same scale (answers median 0.672, no-answer best 0.543), so the floor carries
over; it embedded 21% slower than fp32 on this Mac.

**Model size.** Compressed, the fp32 graph adds 73 MB to a download (127 MB
installed) and the int8 graph 23 MB (33 MB). The packaged Mac app is 719 MB,
129 MB of it the model.

## Scale

`npm run bench:index -- --sizes 5000,50000 --persistent` on the seeded fixture
(~6 KB notes; Node's SQLite standing in for the worker's sqlite-wasm), measured
2026-11-21 on an M5 Max:

| Notes  | Database | First build | Relaunch after one edit | Literal search | Best matches |
| ------ | -------: | ----------: | ----------------------: | -------------: | -----------: |
| 4,496  |   100 MB |        17 s |    0.11 s (1 note read) |       53–98 ms |   0.1–1.1 ms |
| 45,064 |   1.0 GB |       183 s |    1.07 s (1 note read) |     334–594 ms |   0.1–2.4 ms |

Before the persistent engine, the index re-read every note at each launch
(76 s at 50k) and kept text for only the first ~4,400 notes (the 24M-character
page budget), so a term in the rest was silently not found. The first build
is CPU: Markdown parsing (~1.2 ms a note) and token chunking (~1.2 ms; the
chunker counts tokens about 60 times per note). The database is 3.6× the
notes: each payload keeps the note's rendered search text (literal search
needs it exactly), beside the body the full-text index reads, and FTS5 is
another third. Literal search reads every payload but parses only those whose
raw JSON can match (`payloadScreen` in `live-engine.ts`).

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
- Packaged: `packages/desktop/e2e/packaged-search.spec.ts` (in
  `npm run test:e2e:packaged -w docblocks-desktop`) searches by meaning on the
  real bundled model inside the electron-builder output.
- Retrieval quality: see above.
- Scale: `npm run bench:index -- --sizes 5000,50000` writes a report to
  `reports/`; `--persistent` adds the desktop's persistent index (cold build,
  relaunch after an edit, database size, query latency).
