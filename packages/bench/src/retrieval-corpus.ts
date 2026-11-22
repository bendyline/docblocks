/**
 * The workspace-retrieval corpus: one person's notes folder
 * (`fixtures/workspace-retrieval/notes/`) and judged queries
 * (`fixtures/workspace-retrieval/queries.json`), with the ranking metrics the
 * eval (`npm run eval:workspace-retrieval`) and its unit test share.
 *
 * Judgements are per note: grade 2 answers the query, grade 1 is related (a
 * near-duplicate, a partial answer). Every grade-2 judgement quotes its
 * answer verbatim (`evidence`), which places it on a line, so a passage can
 * be scored on whether it holds the answer and not only whether it is from
 * the right note.
 */
import fs from 'node:fs';
import path from 'node:path';

export const RETRIEVAL_QUERY_KINDS = ['lexical', 'paraphrase', 'detail', 'none'] as const;

/**
 * - `lexical`: shares distinctive words with the note.
 * - `paraphrase`: says the same thing in other words.
 * - `detail`: answered by one fact buried in a long note.
 * - `none`: nothing in the corpus answers it.
 */
export type RetrievalQueryKind = (typeof RETRIEVAL_QUERY_KINDS)[number];

export interface RetrievalJudgement {
  /** The note's path inside `notes/`. */
  readonly path: string;
  readonly grade: 1 | 2;
  /** Grade 2 only: the answer, verbatim from the note, on one line. */
  readonly evidence?: string;
  /** Grade 2 only: the 1-based line the evidence is on. */
  readonly evidenceLine?: number;
}

export interface RetrievalQuery {
  readonly id: string;
  readonly query: string;
  readonly kind: RetrievalQueryKind;
  readonly relevant: readonly RetrievalJudgement[];
}

export interface CorpusNote {
  readonly path: string;
  readonly text: string;
}

export interface RetrievalCorpus {
  readonly notes: readonly CorpusNote[];
  readonly queries: readonly RetrievalQuery[];
}

export const RETRIEVAL_CORPUS_DIR = path.resolve(
  import.meta.dirname,
  '../fixtures/workspace-retrieval',
);

function listNotes(root: string, folder = ''): string[] {
  const entries = fs.readdirSync(path.join(root, folder), { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return listNotes(root, relative);
      return entry.isFile() && entry.name.endsWith('.md') ? [relative] : [];
    })
    .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The corpus, its judgements checked against the notes: every judged note
 * exists, every grade-2 judgement's evidence is on one line of its note.
 * Throws naming the first problem, so a broken fixture fails loudly.
 */
export function loadRetrievalCorpus(dir: string = RETRIEVAL_CORPUS_DIR): RetrievalCorpus {
  const notesDir = path.join(dir, 'notes');
  const notes = listNotes(notesDir).map((relative) => ({
    path: relative,
    text: fs.readFileSync(path.join(notesDir, relative), 'utf8').replace(/\r\n?/g, '\n'),
  }));
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'queries.json'), 'utf8'));
  if (!Array.isArray(raw)) throw new Error('queries.json must be an array.');
  const ids = new Set<string>();
  const queries = raw.map((entry, position): RetrievalQuery => {
    const where = `queries.json[${position}]`;
    if (!isRecord(entry)) throw new Error(`${where} is not an object.`);
    const { id, query, kind, relevant } = entry;
    if (typeof id !== 'string' || !id || ids.has(id)) {
      throw new Error(`${where} needs a unique id.`);
    }
    ids.add(id);
    if (typeof query !== 'string' || !query.trim()) throw new Error(`${id} has no query.`);
    if (!RETRIEVAL_QUERY_KINDS.includes(kind as RetrievalQueryKind)) {
      throw new Error(`${id} has an unknown kind.`);
    }
    if (!Array.isArray(relevant)) throw new Error(`${id} needs a relevant list.`);
    if ((kind === 'none') !== (relevant.length === 0)) {
      throw new Error(`${id}: a "none" query judges no note, and every other query some.`);
    }
    const judgements = relevant.map((judgement: unknown): RetrievalJudgement => {
      if (!isRecord(judgement)) throw new Error(`${id} has a malformed judgement.`);
      const { path: notePath, grade, evidence } = judgement;
      const note = typeof notePath === 'string' ? byPath.get(notePath) : undefined;
      if (!note) throw new Error(`${id} judges a note that does not exist: ${String(notePath)}`);
      if (grade !== 1 && grade !== 2) throw new Error(`${id}: grade must be 1 or 2.`);
      if (grade === 1) return { path: note.path, grade };
      if (typeof evidence !== 'string' || !evidence || evidence.includes('\n')) {
        throw new Error(`${id}: a grade-2 judgement quotes its answer on one line.`);
      }
      const lineIndex = note.text.split('\n').findIndex((line) => line.includes(evidence));
      if (lineIndex === -1) throw new Error(`${id}: evidence not found in ${note.path}.`);
      return { path: note.path, grade, evidence, evidenceLine: lineIndex + 1 };
    });
    if (kind !== 'none' && !judgements.some((judgement) => judgement.grade === 2)) {
      throw new Error(`${id} has no grade-2 note.`);
    }
    return { id, query, kind: kind as RetrievalQueryKind, relevant: judgements };
  });
  return { notes, queries };
}

/** A ranked passage: which note, which lines. */
export interface RankedPassage {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface QueryScore {
  readonly id: string;
  readonly kind: RetrievalQueryKind;
  /** 1-based rank of the first grade-2 note among distinct notes; null when absent. */
  readonly noteRank: number | null;
  /** Graded nDCG over the first 10 distinct notes (gains 3 and 1). */
  readonly ndcg10: number;
  /** 1-based rank of the first passage holding a grade-2 answer; null when absent. */
  readonly answerRank: number | null;
}

const gain = (grade: number) => 2 ** grade - 1;

/** How well one query's ranked passages did. */
export function scoreRanking(
  query: RetrievalQuery,
  passages: readonly RankedPassage[],
): QueryScore {
  const grades = new Map(query.relevant.map((judgement) => [judgement.path, judgement.grade]));
  const notes: string[] = [];
  for (const passage of passages) if (!notes.includes(passage.path)) notes.push(passage.path);
  const noteIndex = notes.findIndex((note) => grades.get(note) === 2);
  const dcg = notes
    .slice(0, 10)
    .reduce((sum, note, rank) => sum + gain(grades.get(note) ?? 0) / Math.log2(rank + 2), 0);
  const ideal = [...grades.values()]
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((sum, grade, rank) => sum + gain(grade) / Math.log2(rank + 2), 0);
  const answerIndex = passages.findIndex((passage) =>
    query.relevant.some(
      (judgement) =>
        judgement.evidenceLine !== undefined &&
        judgement.path === passage.path &&
        passage.lineStart <= judgement.evidenceLine &&
        judgement.evidenceLine <= passage.lineEnd,
    ),
  );
  return {
    id: query.id,
    kind: query.kind,
    noteRank: noteIndex === -1 ? null : noteIndex + 1,
    ndcg10: ideal > 0 ? dcg / ideal : 0,
    answerRank: answerIndex === -1 ? null : answerIndex + 1,
  };
}

export interface RankingSummary {
  readonly queries: number;
  /** Share of queries whose answering note ranks first, in the top 5, in the top 10. */
  readonly hit1: number;
  readonly hit5: number;
  readonly hit10: number;
  readonly mrr10: number;
  readonly ndcg10: number;
  /** Share of queries with a passage holding the answer in the top 5 / top 10 passages. */
  readonly answer5: number;
  readonly answer10: number;
}

/** Means over the scores of queries that have an answer. */
export function summarizeRanking(scores: readonly QueryScore[]): RankingSummary {
  const answerable = scores.filter((score) => score.kind !== 'none');
  const share = (test: (score: QueryScore) => boolean) =>
    answerable.length ? answerable.filter(test).length / answerable.length : 0;
  const within = (rank: number | null, k: number) => rank !== null && rank <= k;
  return {
    queries: answerable.length,
    hit1: share((score) => within(score.noteRank, 1)),
    hit5: share((score) => within(score.noteRank, 5)),
    hit10: share((score) => within(score.noteRank, 10)),
    mrr10: answerable.length
      ? answerable.reduce(
          (sum, score) => sum + (within(score.noteRank, 10) ? 1 / (score.noteRank ?? 1) : 0),
          0,
        ) / answerable.length
      : 0,
    ndcg10: answerable.length
      ? answerable.reduce((sum, score) => sum + score.ndcg10, 0) / answerable.length
      : 0,
    answer5: share((score) => within(score.answerRank, 5)),
    answer10: share((score) => within(score.answerRank, 10)),
  };
}
