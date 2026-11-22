/**
 * Retrieval quality of workspace search, measured over a judged notes corpus
 * (`packages/bench/fixtures/workspace-retrieval/`) with the product's own
 * code: the persistent engine over Gezel's live index, the catalogs'
 * token chunking with the bundled model's tokenizer, Gezel's profile
 * embedder over the bundled model, and the AI grounding filter.
 *
 * Arms:
 * - `words`: Best matches with no embedding model (BM25).
 * - `hybrid`: Best matches with semantic search on (BM25 fused with vectors).
 * - `meaning`: the vector arm alone with no floor, for calibration.
 * - `grounding`: what AI drafts and Ask send the model
 *   (`findWorkspacePassages`): passages found by meaning above the floor.
 *
 * Also sweeps the vector floor (spike S4): for each candidate floor, how many
 * answers clear it, and how often an unrelated passage or a question with no
 * answer in the workspace does.
 *
 *   npm run eval:workspace-retrieval -- [--label <name>] [--quantized]
 *
 * `--model-dir` is a transformers.js cache holding the pinned model (default:
 * the desktop's staged copy, `npm run stage:embedding-model -w
 * docblocks-desktop`). `--quantized` swaps in the 34 MB int8 graph from the
 * same model revision (downloaded once into reports/, digest recorded), for
 * spike S6: the floor is still the fp32 profile's, which is the question.
 *
 * Writes `results.json` and `summary.md` to
 * `reports/workspace-retrieval-evals/<label>/`. Not part of `npm run all`:
 * it needs the model. The lexical arm is asserted in `npm test`
 * (`packages/bench/test/workspace-retrieval.test.ts`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Tokenizer } from '@huggingface/tokenizers';
import { createProfileEmbedder } from '@bendyline/gezel-knowledge';
import {
  BGE_SMALL_EN_V15_1,
  LiveIndex,
  liveIndexEmbedding,
  type KnowledgeEmbeddingProfile,
} from '@bendyline/gezel-retrieval';
import { MemoryFileSystemProviderV2 } from '../packages/core/src/filesystem/memory-provider-v2.js';
import { parseWorkspacePath } from '../packages/core/src/filesystem/workspace-path.js';
import { parseWorkspacePassageUri } from '../packages/core/src/host/ai-workspace-knowledge.js';
import {
  LIVE_ENGINE_PAYLOAD_FORMAT,
  createLiveIndexEngine,
  createWorkspaceIndex,
  type WorkspaceIndex,
} from '../packages/core/src/workspace-index/index.js';
import {
  RETRIEVAL_QUERY_KINDS,
  loadRetrievalCorpus,
  scoreRanking,
  summarizeRanking,
  type RankedPassage,
  type RetrievalQuery,
  type RankingSummary,
  type QueryScore,
} from '../packages/bench/src/retrieval-corpus.js';
import { findWorkspacePassages } from '../packages/react/src/Ai/workspace-grounding.js';
import {
  RANKED_PASSAGE_LIMIT,
  RANKED_PASSAGES_PER_DOCUMENT,
} from '../packages/react/src/WorkspaceSearch/ranked-results.js';

type NodeSqlite = typeof import('node:sqlite');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqlite;

const root = path.resolve(import.meta.dirname, '..');
const WORKSPACE_ID = 'workspace-retrieval-eval';
/** The live index scans at most this many passages per semantic query. */
const SCAN_LIMIT = 200;
/** Vector floors Best matches is scored at (null: none). */
const SEARCH_FLOORS: ReadonlyArray<number | null> = [null, 0.45, 0.5, 0.55];
/** Admission rules for AI grounding: an absolute floor, and a margin below the best passage. */
const ADMISSION_FLOORS = [0.5, 0.525, 0.55, 0.575, 0.6];
const ADMISSION_MARGINS = [Infinity, 0.12, 0.1, 0.08, 0.06, 0.04];
/** What grounding sends at most: passages, and passages per note (see workspace-grounding.ts). */
const GROUNDING_PASSAGES = 6;
const GROUNDING_PER_NOTE = 2;
const FLOORS = Array.from(
  { length: 17 },
  (_, step) => Math.round((0.4 + step * 0.025) * 1000) / 1000,
);

interface Args {
  readonly label: string;
  readonly modelDir: string;
  readonly quantized: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const quantized = argv.includes('--quantized');
  return {
    label:
      value('--label') ??
      `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}${quantized ? '-q8' : ''}`,
    modelDir: path.resolve(
      value('--model-dir') ?? path.join(root, 'packages/desktop/dist/embedding-model'),
    ),
    quantized,
  };
}

const QUANTIZED_GRAPH = 'onnx/model_quantized.onnx';

/**
 * The bundled profile with the int8 graph from the same revision: a cache
 * beside the report holding the fp32 cache's tokenizer and configs plus the
 * quantized graph, and a profile pinning its digest. Experimental only — a
 * shipped quantized profile needs its own id and measured floor in Gezel.
 */
async function quantizedProfile(
  fp32Dir: string,
): Promise<{ profile: KnowledgeEmbeddingProfile; cacheDir: string }> {
  const base = BGE_SMALL_EN_V15_1;
  const cacheDir = path.join(root, 'reports/workspace-retrieval-evals/.model-cache');
  const repoDir = path.join(cacheDir, base.model.repo);
  const revisionDir = path.join(repoDir, base.model.revision);
  const graph = path.join(revisionDir, QUANTIZED_GRAPH);
  fs.mkdirSync(path.dirname(graph), { recursive: true });
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
    fs.copyFileSync(
      path.join(fp32Dir, base.model.repo, base.model.revision, file),
      path.join(revisionDir, file),
    );
  }
  fs.copyFileSync(
    path.join(fp32Dir, base.model.repo, 'config.json'),
    path.join(repoDir, 'config.json'),
  );
  if (!fs.existsSync(graph)) {
    const url = `https://huggingface.co/${base.model.repo}/resolve/${base.model.revision}/${QUANTIZED_GRAPH}`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Could not download the quantized graph (${response.status}).`);
    fs.writeFileSync(graph, Buffer.from(await response.arrayBuffer()));
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(graph)).digest('hex');
  return {
    cacheDir,
    profile: {
      ...base,
      id: 'bge-small-en-v1.5-q8@eval',
      model: { ...base.model, onnxFile: QUANTIZED_GRAPH, onnxDigest: `sha256:${digest}` },
    },
  };
}

/** The tokenizer counter the index worker builds from the host's files. */
function tokenCounter(
  modelDir: string,
  profile: KnowledgeEmbeddingProfile,
): (text: string) => number {
  const dir = path.join(modelDir, profile.model.repo, profile.model.revision);
  const tokenizer = new Tokenizer(
    JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')) as object,
    JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8')) as object,
  );
  return (text) => tokenizer.encode(text, { add_special_tokens: false }).ids.length;
}

async function settled(index: WorkspaceIndex): Promise<void> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const status = index.getStatus();
    if (status.phase === 'ready' && status.pendingCount === 0) return;
    if (status.phase === 'error') throw new Error(status.error ?? 'The index failed.');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('The index never settled.');
}

interface FloorRow {
  readonly floor: number;
  /** Answerable queries whose answer passage clears the floor. */
  readonly answersKept: number;
  /** Queries (answerable or not) where some passage from an unjudged note clears it. */
  readonly unrelatedAdmitted: number;
  /** "None" queries where anything clears it. */
  readonly noneAdmitted: number;
}

interface QueryRecord {
  readonly id: string;
  readonly kind: RetrievalQuery['kind'];
  readonly query: string;
  readonly words: QueryScore;
  readonly hybrid: QueryScore;
  readonly meaning: QueryScore;
  /** Cosine of the best passage holding the answer; null when outside the scan. */
  readonly answerCosine: number | null;
  /** Cosine of the best passage from a note judged neither 1 nor 2. */
  readonly unrelatedCosine: number | null;
  readonly grounding: {
    readonly passages: readonly (RankedPassage & { readonly grade: number })[];
    readonly answered: boolean;
  };
  readonly topNotes: { readonly words: string[]; readonly hybrid: string[] };
  /** Best matches at each of SEARCH_FLOORS, in order. */
  readonly searchFloors: readonly QueryScore[];
  /** The nearest passages by meaning, for the admission analysis. */
  readonly nearest: ReadonlyArray<{
    readonly path: string;
    readonly similarity: number;
    readonly grade: number;
    readonly answer: boolean;
  }>;
}

interface AdmissionRow {
  readonly floor: number;
  readonly margin: number;
  /** Answerable questions whose answer passage is sent. */
  readonly answered: number;
  /** Answerable questions sending anything. */
  readonly sending: number;
  readonly passages: number;
  /** Sent passages from a note judged 1 or 2. */
  readonly relevant: number;
  /** Answerable questions sending a passage from an unjudged note. */
  readonly withUnrelated: number;
  /** "None" questions sending anything. */
  readonly none: number;
}

/** Grounding's selection under one rule, from the nearest passages (best first). */
function admit(
  nearest: QueryRecord['nearest'],
  floor: number,
  margin: number,
): QueryRecord['nearest'] {
  const best = nearest[0]?.similarity ?? 0;
  const perNote = new Map<string, number>();
  const sent: Array<QueryRecord['nearest'][number]> = [];
  for (const hit of nearest) {
    if (sent.length >= GROUNDING_PASSAGES) break;
    if (hit.similarity < floor || hit.similarity < best - margin) break;
    const count = perNote.get(hit.path) ?? 0;
    if (count >= GROUNDING_PER_NOTE) continue;
    perNote.set(hit.path, count + 1);
    sent.push(hit);
  }
  return sent;
}

function distinctNotes(passages: readonly RankedPassage[], count: number): string[] {
  const notes: string[] = [];
  for (const passage of passages) {
    if (!notes.includes(passage.path)) notes.push(passage.path);
    if (notes.length === count) break;
  }
  return notes;
}

const percent = (value: number) => `${(value * 100).toFixed(0)}%`;

function rankingTable(rows: ReadonlyArray<readonly [string, RankingSummary]>): string {
  const lines = [
    '| Arm | Queries | Note @1 | Note @5 | Note @10 | MRR@10 | nDCG@10 | Answer passage @5 | @10 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [arm, summary] of rows) {
    lines.push(
      `| ${arm} | ${summary.queries} | ${percent(summary.hit1)} | ${percent(summary.hit5)} | ${percent(summary.hit10)} | ${summary.mrr10.toFixed(3)} | ${summary.ndcg10.toFixed(3)} | ${percent(summary.answer5)} | ${percent(summary.answer10)} |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadRetrievalCorpus();
  const outDir = path.join(root, 'reports/workspace-retrieval-evals', args.label);
  fs.mkdirSync(outDir, { recursive: true });

  const { profile, cacheDir } = args.quantized
    ? await quantizedProfile(args.modelDir)
    : { profile: BGE_SMALL_EN_V15_1, cacheDir: args.modelDir };
  process.stderr.write(`Loading ${profile.id} from ${cacheDir}\n`);
  const loadStarted = performance.now();
  const embedder = await createProfileEmbedder(profile, { cacheDir, localFilesOnly: true });
  const loadSeconds = (performance.now() - loadStarted) / 1000;

  // The workspace, indexed the way the app's worker does it.
  const provider = new MemoryFileSystemProviderV2(WORKSPACE_ID, 'Retrieval eval');
  for (const note of corpus.notes) {
    await provider.writeFile(parseWorkspacePath(note.path), new TextEncoder().encode(note.text), {
      createParents: true,
    });
  }
  const live = LiveIndex.open(new DatabaseSync(':memory:'), {
    // The live index scales the vectors' floor by the profile it is given; the
    // quantized arm is scored against the fp32 profile's floor on purpose.
    ...liveIndexEmbedding(
      args.quantized ? { ...profile, id: BGE_SMALL_EN_V15_1.id } : profile,
      tokenCounter(cacheDir, profile),
    ),
    appVersion: `docblocks-workspace-index@eval/${LIVE_ENGINE_PAYLOAD_FORMAT}`,
  });
  const engine = createLiveIndexEngine(live);
  const queryVectors = new Map<string, Promise<ArrayLike<number>>>();
  const embedQuery = (query: string) => {
    let vector = queryVectors.get(query);
    if (!vector) {
      vector = embedder.embedQuery(query);
      queryVectors.set(query, vector);
    }
    return vector;
  };
  const index = createWorkspaceIndex({
    workspaceId: WORKSPACE_ID,
    source: {
      stat: (target) => provider.stat(target),
      readFile: (target) => provider.readFile(target),
      readDirectory: (target) => provider.readDirectory(target),
      capabilities: { watch: false },
    },
    engine,
    embedQuery,
    yieldControl: () => Promise.resolve(),
    changeCoalesceMs: 0,
    minRefreshIntervalMs: 0,
  });
  index.start();
  await settled(index);

  // Every passage embedded, in the scheduler's batch size.
  const embedStarted = performance.now();
  for (;;) {
    const pending = engine.pendingEmbeddings(16);
    if (!pending.length) break;
    const vectors = await embedder.embed(pending.map((passage) => passage.input));
    engine.storeEmbeddings(
      pending.map((passage, at) => ({ hash: passage.hash, vector: vectors[at]! })),
    );
  }
  const embedSeconds = (performance.now() - embedStarted) / 1000;
  const stats = live.stats();
  const embedded = engine.embeddingStats();
  if (stats.chunks > SCAN_LIMIT) {
    process.stderr.write(
      `Note: ${stats.chunks} passages exceed the ${SCAN_LIMIT}-passage scan; cosines below the scan are unknown.\n`,
    );
  }

  const records: QueryRecord[] = [];
  for (const query of corpus.queries) {
    const vector = await embedQuery(query.query);
    const words = engine.find(query.query, {
      limit: RANKED_PASSAGE_LIMIT,
      perDocument: RANKED_PASSAGES_PER_DOCUMENT,
    });
    const hybrid = engine.find(query.query, {
      limit: RANKED_PASSAGE_LIMIT,
      perDocument: RANKED_PASSAGES_PER_DOCUMENT,
      vector,
    });
    const meaning = live.semanticSearch(vector, {
      limit: SCAN_LIMIT,
      perDocument: SCAN_LIMIT,
      floor: null,
    });
    const grades = new Map(query.relevant.map((judgement) => [judgement.path, judgement.grade]));
    const holdsAnswer = (passage: RankedPassage) =>
      query.relevant.some(
        (judgement) =>
          judgement.evidenceLine !== undefined &&
          judgement.path === passage.path &&
          passage.lineStart <= judgement.evidenceLine &&
          judgement.evidenceLine <= passage.lineEnd,
      );
    const answerHit = meaning.find(holdsAnswer);
    const unrelatedHit = meaning.find((hit) => !grades.has(hit.path));
    const grounded = await findWorkspacePassages(index, WORKSPACE_ID, query.query, {
      deadlineMs: 30_000,
    });
    const groundedPassages = grounded.flatMap((passage) => {
      const reference = parseWorkspacePassageUri(passage.uri);
      return reference
        ? [
            {
              path: reference.path,
              lineStart: reference.lineStart,
              lineEnd: reference.lineEnd,
              grade: grades.get(reference.path) ?? 0,
            },
          ]
        : [];
    });
    const searchFloors = SEARCH_FLOORS.map((searchFloor) =>
      scoreRanking(
        query,
        live.hybridSearch(query.query, vector, {
          limit: RANKED_PASSAGE_LIMIT,
          perDocument: RANKED_PASSAGES_PER_DOCUMENT,
          floor: searchFloor,
        }),
      ),
    );
    records.push({
      searchFloors,
      nearest: meaning.slice(0, 40).map((hit) => ({
        path: hit.path,
        similarity: hit.similarity ?? 0,
        grade: grades.get(hit.path) ?? 0,
        answer: holdsAnswer(hit),
      })),
      id: query.id,
      kind: query.kind,
      query: query.query,
      words: scoreRanking(query, words),
      hybrid: scoreRanking(query, hybrid),
      meaning: scoreRanking(query, meaning),
      answerCosine: answerHit?.similarity ?? null,
      unrelatedCosine: unrelatedHit?.similarity ?? null,
      grounding: { passages: groundedPassages, answered: groundedPassages.some(holdsAnswer) },
      topNotes: { words: distinctNotes(words, 3), hybrid: distinctNotes(hybrid, 3) },
    });
  }
  index.dispose();

  const answerable = records.filter((record) => record.kind !== 'none');
  const none = records.filter((record) => record.kind === 'none');
  const floors: FloorRow[] = FLOORS.map((candidate) => ({
    floor: candidate,
    answersKept: answerable.filter((record) => (record.answerCosine ?? 0) >= candidate).length,
    unrelatedAdmitted: records.filter((record) => (record.unrelatedCosine ?? 0) >= candidate)
      .length,
    noneAdmitted: none.filter((record) => (record.unrelatedCosine ?? 0) >= candidate).length,
  }));
  const admission: AdmissionRow[] = ADMISSION_FLOORS.flatMap((admissionFloor) =>
    ADMISSION_MARGINS.map((margin) => {
      const sent = (record: QueryRecord) => admit(record.nearest, admissionFloor, margin);
      const answerableSent = answerable.map(sent);
      return {
        floor: admissionFloor,
        margin,
        answered: answerableSent.filter((passages) => passages.some((hit) => hit.answer)).length,
        sending: answerableSent.filter((passages) => passages.length > 0).length,
        passages: answerableSent.reduce((sum, passages) => sum + passages.length, 0),
        relevant: answerableSent.reduce(
          (sum, passages) => sum + passages.filter((hit) => hit.grade > 0).length,
          0,
        ),
        withUnrelated: answerableSent.filter((passages) => passages.some((hit) => hit.grade === 0))
          .length,
        none: none.filter((record) => sent(record).length > 0).length,
      };
    }),
  );
  const searchFloorSummaries = SEARCH_FLOORS.map((searchFloor, at) => ({
    floor: searchFloor,
    all: summarizeRanking(records.map((record) => record.searchFloors[at]!)),
    paraphrase: summarizeRanking(
      records
        .filter((record) => record.kind === 'paraphrase')
        .map((record) => record.searchFloors[at]!),
    ),
    /** Answerable queries that come back empty. */
    empty: answerable.filter((record) => record.searchFloors[at]!.noteRank === null).length,
  }));
  const kinds = RETRIEVAL_QUERY_KINDS.filter((kind) => kind !== 'none');
  const summaries = {
    all: {
      words: summarizeRanking(records.map((record) => record.words)),
      hybrid: summarizeRanking(records.map((record) => record.hybrid)),
      meaning: summarizeRanking(records.map((record) => record.meaning)),
    },
    ...Object.fromEntries(
      kinds.map((kind) => {
        const ofKind = records.filter((record) => record.kind === kind);
        return [
          kind,
          {
            words: summarizeRanking(ofKind.map((record) => record.words)),
            hybrid: summarizeRanking(ofKind.map((record) => record.hybrid)),
            meaning: summarizeRanking(ofKind.map((record) => record.meaning)),
          },
        ];
      }),
    ),
  } as Record<string, Record<'words' | 'hybrid' | 'meaning', RankingSummary>>;

  const admitted = records.flatMap((record) => record.grounding.passages);
  const grounding = {
    answered: answerable.filter((record) => record.grounding.answered).length,
    answerable: answerable.length,
    withAnyPassage: answerable.filter((record) => record.grounding.passages.length > 0).length,
    noneWithPassages: none.filter((record) => record.grounding.passages.length > 0).length,
    none: none.length,
    passages: admitted.length,
    relevantPassages: admitted.filter((passage) => passage.grade > 0).length,
  };
  const cosines = (values: Array<number | null>) =>
    values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const answerCosines = cosines(answerable.map((record) => record.answerCosine));
  const noneCosines = cosines(none.map((record) => record.unrelatedCosine));
  const unrelatedCosines = cosines(records.map((record) => record.unrelatedCosine));
  const quantile = (values: number[], q: number) =>
    values.length ? values[Math.min(values.length - 1, Math.floor(q * values.length))]! : NaN;

  const result = {
    label: args.label,
    profile: profile.id,
    graph: profile.model.onnxFile,
    corpus: {
      notes: corpus.notes.length,
      words: corpus.notes.reduce(
        (sum, note) => sum + note.text.split(/\s+/).filter(Boolean).length,
        0,
      ),
      passages: stats.chunks,
      queries: Object.fromEntries(
        RETRIEVAL_QUERY_KINDS.map((kind) => [
          kind,
          records.filter((record) => record.kind === kind).length,
        ]),
      ),
    },
    timing: {
      modelLoadSeconds: loadSeconds,
      embedSeconds,
      passagesPerSecond: embedded.embedded / embedSeconds,
    },
    floorInUse: 0.55,
    summaries,
    grounding,
    cosines: {
      answers: {
        min: answerCosines[0],
        p10: quantile(answerCosines, 0.1),
        median: quantile(answerCosines, 0.5),
      },
      unrelatedBest: {
        median: quantile(unrelatedCosines, 0.5),
        p90: quantile(unrelatedCosines, 0.9),
        max: unrelatedCosines.at(-1),
      },
      noneBest: noneCosines,
    },
    floors,
    admission,
    searchFloorSummaries,
    records,
  };
  fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);

  const misses = (arm: 'words' | 'hybrid') =>
    records
      .filter((record) => record.kind !== 'none' && (record[arm].noteRank ?? 99) > 5)
      .map(
        (record) =>
          `- \`${record.id}\` (${record.kind}) "${record.query}" → ${record.topNotes[arm].join(', ') || 'nothing'}`,
      );
  const summary = [
    `# Workspace retrieval eval: ${args.label}`,
    '',
    `Profile \`${profile.id}\` (${profile.model.onnxFile}); ${result.corpus.notes} notes, ${result.corpus.words.toLocaleString()} words, ${stats.chunks} passages; ${records.length} queries (${Object.entries(
      result.corpus.queries,
    )
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ')}).`,
    `Model load ${loadSeconds.toFixed(1)} s; embedding ${result.timing.passagesPerSecond.toFixed(0)} passages/s (this process, default threads).`,
    '',
    '## Ranking (answerable queries)',
    '',
    rankingTable([
      ['Words (no model)', summaries.all!.words],
      ['Hybrid (Best matches)', summaries.all!.hybrid],
      ['Meaning only, no floor', summaries.all!.meaning],
    ]),
    '',
    ...kinds.flatMap((kind) => [
      `### ${kind}`,
      '',
      rankingTable([
        ['Words', summaries[kind]!.words],
        ['Hybrid', summaries[kind]!.hybrid],
        ['Meaning', summaries[kind]!.meaning],
      ]),
      '',
    ]),
    '## AI grounding (passages sent with a draft or an Ask question)',
    '',
    `- Answer passage sent: ${grounding.answered} of ${grounding.answerable} answerable questions (${percent(grounding.answered / grounding.answerable)}).`,
    `- Any passage sent: ${grounding.withAnyPassage} of ${grounding.answerable}.`,
    `- Passages from a judged note: ${grounding.relevantPassages} of ${grounding.passages} sent (${percent(grounding.passages ? grounding.relevantPassages / grounding.passages : 0)}).`,
    `- Questions with no answer in the workspace that still sent passages: ${grounding.noneWithPassages} of ${grounding.none}.`,
    '',
    '## Vector floor (S4)',
    '',
    `Answer passages' cosine: min ${answerCosines[0]?.toFixed(3)}, 10th percentile ${quantile(answerCosines, 0.1).toFixed(3)}, median ${quantile(answerCosines, 0.5).toFixed(3)}.`,
    `Best unrelated passage per query: median ${quantile(unrelatedCosines, 0.5).toFixed(3)}, 90th percentile ${quantile(unrelatedCosines, 0.9).toFixed(3)}, max ${unrelatedCosines.at(-1)?.toFixed(3)}.`,
    `"None" questions' best passage: ${noneCosines.map((value) => value.toFixed(3)).join(', ')}.`,
    '',
    '| Floor | Answers kept | Queries admitting an unrelated passage | "None" questions admitting anything |',
    '|---:|---:|---:|---:|',
    ...floors.map(
      (row) =>
        `| ${row.floor.toFixed(3)}${row.floor === 0.55 ? ' (in use)' : ''} | ${row.answersKept}/${answerable.length} | ${row.unrelatedAdmitted}/${records.length} | ${row.noneAdmitted}/${none.length} |`,
    ),
    '',
    '## Best matches by vector floor',
    '',
    rankingTable(
      searchFloorSummaries.map((row) => [
        `Hybrid, floor ${row.floor ?? 'none'}${row.floor === 0.55 ? ' (in use)' : ''}`,
        row.all,
      ]),
    ),
    '',
    'Paraphrase queries only:',
    '',
    rankingTable(
      searchFloorSummaries.map((row) => [`Hybrid, floor ${row.floor ?? 'none'}`, row.paraphrase]),
    ),
    '',
    '## Grounding admission rules',
    '',
    `Nearest passages by meaning, at most ${GROUNDING_PASSAGES} and ${GROUNDING_PER_NOTE} per note, kept while at or above the floor and within the margin of the best one.`,
    '',
    '| Floor | Margin | Answer sent | Sends anything | Precision (judged notes) | Answerable sending an unrelated note | "None" sending |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    ...admission.map(
      (row) =>
        `| ${row.floor.toFixed(3)} | ${Number.isFinite(row.margin) ? row.margin.toFixed(2) : 'none'} | ${row.answered}/${answerable.length} | ${row.sending}/${answerable.length} | ${row.passages ? percent(row.relevant / row.passages) : 'n/a'} (${row.passages}) | ${row.withUnrelated}/${answerable.length} | ${row.none}/${none.length} |`,
    ),
    '',
    '## Misses (answering note not in the top 5)',
    '',
    '### Words',
    '',
    ...misses('words'),
    '',
    '### Hybrid',
    '',
    ...misses('hybrid'),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), summary);
  process.stdout.write(`${summary}\nWrote ${path.relative(root, outDir)}\n`);
}

await main();
