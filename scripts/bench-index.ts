/**
 * Baseline numbers for the workspace index at scale: workspace search V2,
 * phase D0, including spike S5 (desktop listing cost).
 *
 *   npm run bench:index -- [--sizes 500,5000] [--disk] [--dir <parent>] [--keep]
 *
 * In memory (always): today's index over a memory provider — time until names
 * are listed, time until every document is analyzed, retained heap, and
 * literal search latency for a rare, a mid-frequency and a common term.
 *
 * On disk (`--disk`): the fixture written to a temporary folder, then
 * - a metadata-only walk (readdir + stat), what an `enumerate` lane would cost;
 * - the desktop provider's folder-by-folder listing, which hashes file
 *   contents the first time it sees them, cold and then warm;
 * - today's index over the desktop provider (watch off): listing, reads, parse.
 *
 * Persistent (`--persistent`, implies `--disk`): the index the desktop app
 * runs — Gezel's live index in a SQLite file, listing through `enumerate`,
 * passages chunked in the bundled model's tokens when it is staged — built
 * cold, then reopened after one note changed while it was closed: time to
 * ready, notes read, database size, literal and ranked query latency. Node's
 * native SQLite stands in for the app worker's sqlite-wasm on origin-private
 * storage, so the app is somewhat slower than these figures.
 * The OS file cache is warm (the files were just written); a first launch
 * after a reboot reads from disk and is slower.
 *
 * Writes `results.json` and `summary.md` to `reports/index-bench-<stamp>/`.
 * Run through `node --expose-gc` (the npm script does) for heap figures.
 * Work runs without yielding to timers, so times are CPU cost on Node; the
 * browser's main thread adds its slice yields on top.
 */
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { Tokenizer } from '@huggingface/tokenizers';
import {
  BGE_SMALL_EN_V15_1,
  LiveIndex,
  liveIndexEmbedding,
  markdownChunksByCharacters,
} from '@bendyline/gezel-retrieval';
import { parseWorkspacePath as parseDesktopPath } from '@bendyline/docblocks/filesystem';
import { MemoryFileSystemProviderV2 } from '../packages/core/src/filesystem/memory-provider-v2.js';
import { parseWorkspacePath } from '../packages/core/src/filesystem/workspace-path.js';
import {
  LIVE_ENGINE_PAYLOAD_FORMAT,
  WORKSPACE_INDEX_STORE_LIMITS,
  createLiveIndexEngine,
  createWorkspaceIndex,
  type WorkspaceIndex,
  type WorkspaceIndexEngine,
  type WorkspaceIndexSource,
  type WorkspaceIndexStatus,
} from '../packages/core/src/workspace-index/index.js';
import { NodeWorkspaceFileSystemV2 } from '../packages/desktop/main/node-workspace-filesystem-v2.js';
import { getWorkspaceRoots } from '../packages/desktop/main/workspace-roots.js';
import { createScaleFixture, type ScaleFixture } from './workspace-scale-fixture.js';

type NodeSqlite = typeof import('node:sqlite');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqlite;

interface Args {
  readonly sizes: readonly number[];
  readonly disk: boolean;
  readonly persistent: boolean;
  readonly dir: string;
  readonly keep: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let sizes = [500, 5000];
  let disk = false;
  let persistent = false;
  let dir = os.tmpdir();
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sizes') {
      sizes = (argv[++index] ?? '')
        .split(',')
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isSafeInteger(value) && value > 0);
    } else if (arg === '--disk') disk = true;
    else if (arg === '--persistent') persistent = disk = true;
    else if (arg === '--keep') keep = true;
    else if (arg === '--dir') dir = path.resolve(argv[++index] ?? dir);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!sizes.length) throw new Error('--sizes needs at least one positive integer.');
  return { sizes, disk, persistent, dir, keep };
}

const gc = (globalThis as { gc?: () => void }).gc;
function heapMb(): number | null {
  if (!gc) return null;
  gc();
  gc();
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

async function waitUntil(
  index: WorkspaceIndex,
  done: (status: WorkspaceIndexStatus) => boolean,
  timeoutMs: number,
): Promise<WorkspaceIndexStatus> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const status = index.getStatus();
    if (done(status)) return status;
    if (status.phase === 'error') throw new Error(`Index failed: ${status.error ?? 'unknown'}`);
    if (performance.now() > deadline) throw new Error(`Timed out in phase ${status.phase}.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const settled = (status: WorkspaceIndexStatus) =>
  status.phase === 'ready' && status.listed && status.pendingCount === 0;

interface IndexRun {
  readonly listedMs: number;
  readonly readyMs: number;
  readonly status: Pick<
    WorkspaceIndexStatus,
    'fileCount' | 'documentCount' | 'analyzedCount' | 'issues' | 'truncated'
  >;
  readonly index: WorkspaceIndex;
}

async function runIndex(
  source: WorkspaceIndexSource,
  timeoutMs: number,
  persistent?: { readonly engine: WorkspaceIndexEngine },
): Promise<IndexRun> {
  const index = createWorkspaceIndex({
    workspaceId: 'bench',
    source,
    ...(persistent ? { engine: persistent.engine, limits: WORKSPACE_INDEX_STORE_LIMITS } : {}),
    yieldControl: () => Promise.resolve(),
    changeCoalesceMs: 0,
    minRefreshIntervalMs: 0,
  });
  const started = performance.now();
  index.start();
  await index.whenListed();
  const listedMs = performance.now() - started;
  const status = await waitUntil(index, settled, timeoutMs);
  const readyMs = performance.now() - started;
  const { fileCount, documentCount, analyzedCount, issues, truncated } = status;
  return {
    listedMs,
    readyMs,
    status: { fileCount, documentCount, analyzedCount, issues, truncated },
    index,
  };
}

interface QueryTiming {
  readonly query: string;
  readonly medianMs: number;
  readonly maxMs: number;
  readonly documents: number;
  readonly truncated: boolean;
}

async function timeQueries(
  index: WorkspaceIndex,
  terms: ScaleFixture['terms'],
): Promise<QueryTiming[]> {
  const timings: QueryTiming[] = [];
  for (const query of [terms.rare, terms.mid, terms.common]) {
    const samples: number[] = [];
    let documents = 0;
    let truncated = false;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      const result = await index.search({ text: query });
      samples.push(performance.now() - started);
      documents = result.documents.length;
      truncated = result.truncated;
    }
    timings.push({
      query,
      medianMs: round(median(samples)),
      maxMs: round(Math.max(...samples)),
      documents,
      truncated,
    });
  }
  return timings;
}

async function memoryBench(size: number) {
  const fixture = createScaleFixture({ files: size });
  const provider = new MemoryFileSystemProviderV2(`bench-${size}`, 'Bench');
  let bytes = 0;
  for (const file of fixture.files()) {
    bytes += file.data.byteLength;
    await provider.writeFile(parseWorkspacePath(file.path), file.data, { createParents: true });
  }
  const heapBefore = heapMb();
  const run = await runIndex(provider, 30 * 60_000);
  const heapAfter = heapMb();
  const queries = await timeQueries(run.index, fixture.terms);
  run.index.dispose();
  await provider.dispose();
  return {
    files: size,
    folders: fixture.folderCount,
    fixtureMb: round(bytes / (1024 * 1024)),
    listedMs: round(run.listedMs),
    readyMs: round(run.readyMs),
    retainedHeapMb:
      heapBefore === null || heapAfter === null ? null : round(heapAfter - heapBefore),
    status: run.status,
    queries,
  };
}

async function writeFixture(fixture: ScaleFixture, root: string): Promise<number> {
  const made = new Set<string>();
  let pending: Promise<void>[] = [];
  let count = 0;
  for (const file of fixture.files()) {
    const absolute = path.join(root, ...file.path.split('/'));
    const parent = path.dirname(absolute);
    if (!made.has(parent)) {
      made.add(parent);
      await fs.mkdir(parent, { recursive: true });
    }
    pending.push(fs.writeFile(absolute, file.data));
    count += 1;
    if (pending.length >= 64) {
      await Promise.all(pending);
      pending = [];
    }
  }
  await Promise.all(pending);
  return count;
}

/** What a metadata-only `enumerate` lane would do: names, sizes and times, no reads. */
async function metadataWalk(root: string): Promise<number> {
  let entries = 0;
  const queue = [root];
  while (queue.length) {
    const folder = queue.shift()!;
    const children = await fs.readdir(folder, { withFileTypes: true });
    entries += children.length;
    await Promise.all(
      children.map(async (child) => {
        const absolute = path.join(folder, child.name);
        if (child.isDirectory()) queue.push(absolute);
        else await fs.stat(absolute, { bigint: true });
      }),
    );
  }
  return entries;
}

/**
 * The desktop provider is typed against core's published build, while this
 * script measures core's source. Both deal in the same strings and plain
 * objects at runtime (and the index matches errors by shape), so only the
 * types need bridging.
 */
type DesktopPath = Parameters<NodeWorkspaceFileSystemV2['readDirectory']>[0];
function desktopIndexSource(
  provider: NodeWorkspaceFileSystemV2,
  options: { readonly enumerate: boolean },
): WorkspaceIndexSource {
  const reads = provider as unknown as Pick<
    WorkspaceIndexSource,
    'stat' | 'readFile' | 'readDirectory' | 'enumerate'
  >;
  return {
    stat: (target) => reads.stat(target),
    readFile: (target) => reads.readFile(target),
    readDirectory: (target) => reads.readDirectory(target),
    ...(options.enumerate ? { enumerate: (target) => reads.enumerate!(target) } : {}),
    // Watching adds the provider's own hashing baseline scan; measured apart.
    capabilities: { watch: false },
  };
}

/** The desktop provider's recursive metadata listing, as the index pages through it. */
async function providerEnumerate(provider: NodeWorkspaceFileSystemV2): Promise<number> {
  let entries = 0;
  for await (const page of provider.enumerate(parseDesktopPath(''))) entries += page.entries.length;
  return entries;
}

/** Today's desktop listing, folder by folder, as the index and explorer call it. */
async function providerWalk(provider: NodeWorkspaceFileSystemV2): Promise<number> {
  let entries = 0;
  const queue: DesktopPath[] = [parseDesktopPath('')];
  while (queue.length) {
    const folder = queue.shift()!;
    const children = await provider.readDirectory(folder);
    entries += children.length;
    for (const child of children) if (child.kind === 'directory') queue.push(child.path);
  }
  return entries;
}

/**
 * How the desktop chunks: in the bundled model's tokens when it is staged
 * (`npm run stage:embedding-model -w docblocks-desktop`), else by characters.
 */
function benchChunking() {
  const profile = BGE_SMALL_EN_V15_1;
  const dir = path.resolve(
    'packages/desktop/dist/embedding-model',
    profile.model.repo,
    profile.model.revision,
  );
  try {
    const tokenizer = new Tokenizer(
      JSON.parse(readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')) as object,
      JSON.parse(readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8')) as object,
    );
    return {
      chunking: 'markdown-chunks@2 (bge tokens)',
      shape: liveIndexEmbedding(
        profile,
        (text) => tokenizer.encode(text, { add_special_tokens: false }).ids.length,
      ),
    };
  } catch {
    return {
      chunking: 'markdown-chunks@1 (characters)',
      shape: { chunking: markdownChunksByCharacters() },
    };
  }
}

async function timeRanked(engine: ReturnType<typeof createLiveIndexEngine>, queries: string[]) {
  return queries.map((query) => {
    const samples: number[] = [];
    let hits = 0;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      hits = engine.find(query, { limit: 60, perDocument: 3 }).length;
      samples.push(performance.now() - started);
    }
    return { query, medianMs: round(median(samples)), maxMs: round(Math.max(...samples)), hits };
  });
}

/** The desktop's persistent index: built cold, then reopened after one edit while closed. */
async function persistentBench(
  fixture: ScaleFixture,
  root: string,
  id: string,
  roots: ReturnType<typeof getWorkspaceRoots>,
) {
  const database = `${root}.sqlite3`;
  const { chunking, shape } = benchChunking();
  const launch = async () => {
    const db = new DatabaseSync(database);
    const live = LiveIndex.open(db, {
      ...shape,
      appVersion: `docblocks-workspace-index@bench/${LIVE_ENGINE_PAYLOAD_FORMAT}`,
    });
    const engine = createLiveIndexEngine(live, { onDispose: () => db.close() });
    const provider = new NodeWorkspaceFileSystemV2(id, 'Bench', root, roots);
    let reads = 0;
    const source = desktopIndexSource(provider, { enumerate: true });
    const counted: WorkspaceIndexSource = {
      ...source,
      readFile: (target) => {
        reads += 1;
        return source.readFile(target);
      },
    };
    const run = await runIndex(counted, 60 * 60_000, { engine });
    return { run, engine, live, provider, reads: () => reads };
  };
  try {
    const cold = await launch();
    const stats = cold.live.stats();
    const literal = await timeQueries(cold.run.index, fixture.terms);
    const ranked = await timeRanked(cold.engine, [
      fixture.terms.rare,
      fixture.terms.mid,
      `${fixture.terms.mid} ${fixture.terms.common}`,
    ]);
    const coldReads = cold.reads();
    cold.run.index.dispose();
    await cold.provider.dispose();
    const databaseMb = round((await fs.stat(database)).size / (1024 * 1024));

    // One note edited while the app was closed.
    let edited: string | null = null;
    for (const file of fixture.files()) {
      if (file.path.endsWith('.md')) {
        edited = file.path;
        break;
      }
    }
    if (edited) {
      await fs.appendFile(path.join(root, ...edited.split('/')), '\nEdited while closed.\n');
    }
    const warm = await launch();
    const warmReads = warm.reads();
    warm.run.index.dispose();
    await warm.provider.dispose();
    return {
      chunking,
      databaseMb,
      documents: stats.documents,
      passages: stats.chunks,
      cold: {
        listedMs: round(cold.run.listedMs),
        readyMs: round(cold.run.readyMs),
        reads: coldReads,
        status: cold.run.status,
      },
      relaunch: {
        listedMs: round(warm.run.listedMs),
        readyMs: round(warm.run.readyMs),
        reads: warmReads,
      },
      literal,
      ranked,
    };
  } finally {
    await fs.rm(database, { force: true });
  }
}

async function diskBench(size: number, args: Args) {
  const fixture = createScaleFixture({ files: size });
  await fs.mkdir(args.dir, { recursive: true });
  const root = await fs.mkdtemp(path.join(args.dir, `docblocks-index-bench-${size}-`));
  const roots = getWorkspaceRoots();
  const id = `bench-disk-${size}`;
  roots.register(id, root);
  try {
    const written = await writeFixture(fixture, root);

    let started = performance.now();
    const metadataEntries = await metadataWalk(root);
    const metadataMs = performance.now() - started;

    const cold = new NodeWorkspaceFileSystemV2(id, 'Bench', root, roots);
    started = performance.now();
    const listedEntries = await providerWalk(cold);
    const providerColdMs = performance.now() - started;
    started = performance.now();
    await providerWalk(cold);
    const providerWarmMs = performance.now() - started;
    await cold.dispose();

    const enumerating = new NodeWorkspaceFileSystemV2(id, 'Bench', root, roots);
    started = performance.now();
    const enumeratedEntries = await providerEnumerate(enumerating);
    const enumerateMs = performance.now() - started;
    await enumerating.dispose();

    const fresh = new NodeWorkspaceFileSystemV2(id, 'Bench', root, roots);
    const run = await runIndex(desktopIndexSource(fresh, { enumerate: false }), 30 * 60_000);
    run.index.dispose();
    await fresh.dispose();

    const listed = new NodeWorkspaceFileSystemV2(id, 'Bench', root, roots);
    const enumerated = await runIndex(desktopIndexSource(listed, { enumerate: true }), 30 * 60_000);
    enumerated.index.dispose();
    await listed.dispose();

    const persistent = args.persistent ? await persistentBench(fixture, root, id, roots) : null;

    return {
      persistent,
      files: written,
      metadataWalk: { entries: metadataEntries, ms: round(metadataMs) },
      providerWalk: {
        entries: listedEntries,
        coldMs: round(providerColdMs),
        warmMs: round(providerWarmMs),
      },
      providerEnumerate: { entries: enumeratedEntries, ms: round(enumerateMs) },
      indexOverProvider: {
        listedMs: round(run.listedMs),
        readyMs: round(run.readyMs),
        status: run.status,
      },
      indexOverEnumerate: {
        listedMs: round(enumerated.listedMs),
        readyMs: round(enumerated.readyMs),
        status: enumerated.status,
      },
    };
  } finally {
    roots.unregister(id);
    if (!args.keep) await fs.rm(root, { recursive: true, force: true });
  }
}

function summary(
  memory: Awaited<ReturnType<typeof memoryBench>>[],
  disk: Awaited<ReturnType<typeof diskBench>>[],
): string {
  const lines = [
    '# Workspace index baseline',
    '',
    `${new Date().toISOString()} · Node ${process.version} · ${os.cpus()[0]?.model ?? 'unknown CPU'} · ${os.platform()}`,
    '',
    'Times are CPU cost on Node without slice yields. Heap is retained by the index after a full analysis.',
    '',
    "## Today's index, memory provider",
    '',
    '| Files | Fixture MB | Listed ms | Ready ms | Analyzed / documents | Truncated | Heap MB |',
    '| ---: | ---: | ---: | ---: | ---: | --- | ---: |',
    ...memory.map(
      (run) =>
        `| ${run.files} | ${run.fixtureMb} | ${run.listedMs} | ${run.readyMs} | ${run.status.analyzedCount} / ${run.status.documentCount} | ${run.status.truncated ? `${run.status.truncated.reason} at ${run.status.truncated.limit}` : 'no'} | ${run.retainedHeapMb ?? 'n/a'} |`,
    ),
    '',
    '## Literal search latency (median of 5, ms)',
    '',
    '| Files | Query | Median | Max | Documents | Truncated |',
    '| ---: | --- | ---: | ---: | ---: | --- |',
    ...memory.flatMap((run) =>
      run.queries.map(
        (query) =>
          `| ${run.files} | ${query.query} | ${query.medianMs} | ${query.maxMs} | ${query.documents} | ${query.truncated ? 'yes' : 'no'} |`,
      ),
    ),
  ];
  if (disk.length) {
    lines.push(
      '',
      '## On disk (spike S5)',
      '',
      '| Files | Metadata walk ms | Desktop enumerate ms | Desktop listing cold / warm ms | Index, folder listing: listed / ready ms | Index, enumerate: listed / ready ms |',
      '| ---: | ---: | ---: | ---: | ---: | ---: |',
      ...disk.map(
        (run) =>
          `| ${run.files} | ${run.metadataWalk.ms} | ${run.providerEnumerate.ms} | ${run.providerWalk.coldMs} / ${run.providerWalk.warmMs} | ${run.indexOverProvider.listedMs} / ${run.indexOverProvider.readyMs} | ${run.indexOverEnumerate.listedMs} / ${run.indexOverEnumerate.readyMs} |`,
      ),
      '',
      'The OS file cache was warm; a first launch after a reboot is slower.',
    );
  }
  const persistent = disk.flatMap((run) =>
    run.persistent ? [{ files: run.files, ...run.persistent }] : [],
  );
  if (persistent.length) {
    lines.push(
      '',
      '## Persistent index (the desktop app)',
      '',
      `Chunking: ${persistent[0]!.chunking}. Node's native SQLite in place of the app worker's sqlite-wasm.`,
      '',
      '| Files | Documents / passages | Database MB | Cold: listed / ready ms (reads) | Relaunch after 1 edit: listed / ready ms (reads) |',
      '| ---: | ---: | ---: | ---: | ---: |',
      ...persistent.map(
        (run) =>
          `| ${run.files} | ${run.documents} / ${run.passages} | ${run.databaseMb} | ${run.cold.listedMs} / ${run.cold.readyMs} (${run.cold.reads}) | ${run.relaunch.listedMs} / ${run.relaunch.readyMs} (${run.relaunch.reads}) |`,
      ),
      '',
      '| Files | Search | Query | Median ms | Max ms | Results |',
      '| ---: | --- | --- | ---: | ---: | ---: |',
      ...persistent.flatMap((run) => [
        ...run.literal.map(
          (query) =>
            `| ${run.files} | literal | ${query.query} | ${query.medianMs} | ${query.maxMs} | ${query.documents} notes${query.truncated ? ' (truncated)' : ''} |`,
        ),
        ...run.ranked.map(
          (query) =>
            `| ${run.files} | Best matches | ${query.query} | ${query.medianMs} | ${query.maxMs} | ${query.hits} passages |`,
        ),
      ]),
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const memory: Awaited<ReturnType<typeof memoryBench>>[] = [];
  const disk: Awaited<ReturnType<typeof diskBench>>[] = [];
  for (const size of args.sizes) {
    process.stdout.write(`memory ${size} files…\n`);
    memory.push(await memoryBench(size));
    if (args.disk) {
      process.stdout.write(`disk ${size} files…\n`);
      disk.push(await diskBench(size, args));
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve('reports', `index-bench-${stamp}`);
  await fs.mkdir(outDir, { recursive: true });
  const text = summary(memory, disk);
  await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify({ memory, disk }, null, 2));
  await fs.writeFile(path.join(outDir, 'summary.md'), text);
  process.stdout.write(`${text}\nWrote ${path.relative(process.cwd(), outDir)}/\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
