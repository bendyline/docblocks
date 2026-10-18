/**
 * Study aids: a summary, a quiz, or a flashcard deck made from a document by
 * AI and saved beside it.
 *
 * Each lives in the document's sidecar folder (`notes.md` → `notes_files/`),
 * under `ai/` rather than at the sidecar root: an outside-in companion folder
 * finds its own Markdown by taking the first `*.md` at that root, so a
 * generated file there could be mistaken for it. The sidecar is hidden from
 * the explorer and the workspace index, moves with its document on rename,
 * and the Attachments panel never lists Markdown files.
 *
 * Every saved file carries flat frontmatter naming the document it came
 * from and a hash of that document's body, so a later visit can say when
 * the document has changed since.
 */

import type { ContentContainer } from '@bendyline/squisq/storage';
import {
  parseFrontmatter,
  setFrontmatterValues,
  splitFrontmatterBlock,
} from '@bendyline/squisq/markdown';

export type StudyAidKind = 'summary' | 'quiz' | 'flashcards';

export const STUDY_AID_KINDS: readonly StudyAidKind[] = ['summary', 'quiz', 'flashcards'];

export interface StudyAidLabels {
  /** Menu item in the AI actions menu. */
  readonly menu: string;
  readonly dialogTitle: string;
  /** The heading prefix of the generated document: "Quiz: Onboarding". */
  readonly title: string;
  /** Lower-case noun for sentences: "Generate quiz", "Saved flashcards". */
  readonly noun: string;
  /** What a Report output names as the AI action. */
  readonly feature: string;
}

export const STUDY_AID_LABELS: Readonly<Record<StudyAidKind, StudyAidLabels>> = {
  summary: {
    menu: 'Summarize document…',
    dialogTitle: 'Summarize with AI',
    title: 'Summary',
    noun: 'summary',
    feature: 'Summarize document',
  },
  quiz: {
    menu: 'Create quiz…',
    dialogTitle: 'Create a quiz with AI',
    title: 'Quiz',
    noun: 'quiz',
    feature: 'Create quiz',
  },
  flashcards: {
    menu: 'Create flashcards…',
    dialogTitle: 'Create flashcards with AI',
    title: 'Flashcards',
    noun: 'flashcards',
    feature: 'Create flashcards',
  },
};

/** The folder inside the sidecar that holds every study aid. */
export const STUDY_AID_FOLDER = 'ai';

/** Where `kind` is saved, relative to the document's sidecar folder. */
export function studyAidPath(kind: StudyAidKind): string {
  return `${STUDY_AID_FOLDER}/${kind}.md`;
}

const KEY_KIND = 'docblocks-generated';
const KEY_SOURCE = 'docblocks-source';
const KEY_SOURCE_SHA256 = 'docblocks-source-sha256';
const KEY_GENERATED_AT = 'docblocks-generated-at';
const KEY_MODEL = 'docblocks-model';

export interface StudyAidProvenance {
  readonly kind: StudyAidKind;
  /** The source document's file name, for display. */
  readonly source: string;
  /** SHA-256 of the source body when generated, or null when it could not be hashed. */
  readonly sourceSha256: string | null;
  /** ISO 8601 timestamp. */
  readonly generatedAt: string;
  readonly model: string | null;
}

export interface SavedStudyAid {
  readonly markdown: string;
  /** Null when the frontmatter is missing or was edited out of shape. */
  readonly provenance: StudyAidProvenance | null;
}

function isStudyAidKind(value: unknown): value is StudyAidKind {
  return value === 'summary' || value === 'quiz' || value === 'flashcards';
}

/** `body` with its title and provenance written as frontmatter. */
export function withStudyAidFrontmatter(
  body: string,
  title: string,
  provenance: StudyAidProvenance,
): string {
  // A blank line between the frontmatter and the body, as people write it.
  return setFrontmatterValues(`\n${body.replace(/^\n+/u, '')}`, {
    title,
    // Squisq opens a document carrying this hint in its Study view.
    'display-mode': provenance.kind === 'summary' ? null : 'flashcards',
    [KEY_KIND]: provenance.kind,
    [KEY_SOURCE]: provenance.source,
    [KEY_SOURCE_SHA256]: provenance.sourceSha256,
    [KEY_GENERATED_AT]: provenance.generatedAt,
    [KEY_MODEL]: provenance.model,
  });
}

/** The provenance a saved study aid records, or null when it records none we can trust. */
export function readStudyAidProvenance(markdown: string): StudyAidProvenance | null {
  const { frontmatter } = splitFrontmatterBlock(markdown);
  if (frontmatter === null) return null;
  const yaml = frontmatter.replace(/^---\r?\n/u, '').replace(/\r?\n---\s*$/u, '');
  const values = parseFrontmatter(yaml);
  if (!values) return null;
  const kind = values[KEY_KIND];
  const generatedAt = values[KEY_GENERATED_AT];
  if (!isStudyAidKind(kind) || typeof generatedAt !== 'string') return null;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value : null;
  return {
    kind,
    source: text(values[KEY_SOURCE]) ?? '',
    sourceSha256: text(values[KEY_SOURCE_SHA256]),
    generatedAt,
    model: text(values[KEY_MODEL]),
  };
}

/** The Markdown after its frontmatter, for viewers that would show it as text. */
export function studyAidBody(markdown: string): string {
  return splitFrontmatterBlock(markdown).body.replace(/^\s+/u, '');
}

/**
 * What staleness is measured on: the body without frontmatter, with line
 * endings and trailing space normalized, so a theme change or a Windows
 * checkout does not count as an edit.
 */
function sourceBody(markdown: string): string {
  return splitFrontmatterBlock(markdown)
    .body.replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .trim();
}

/** SHA-256 of the document body, or null where Web Crypto is unavailable. */
export async function studySourceDigest(markdown: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(sourceBody(markdown)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether `markdown` differs from the document `provenance` was made from.
 * Null when that cannot be told: no recorded hash, or no Web Crypto.
 */
export async function studyAidIsStale(
  provenance: StudyAidProvenance | null,
  markdown: string,
): Promise<boolean | null> {
  if (!provenance?.sourceSha256) return null;
  const digest = await studySourceDigest(markdown);
  return digest === null ? null : digest !== provenance.sourceSha256;
}

/** The saved study aid of `kind`, or null when none has been saved. */
export async function readStudyAid(
  container: ContentContainer,
  kind: StudyAidKind,
): Promise<SavedStudyAid | null> {
  const data = await container.readFile(studyAidPath(kind));
  if (data === null) return null;
  const markdown = new TextDecoder().decode(data);
  return { markdown, provenance: readStudyAidProvenance(markdown) };
}

/** Save `markdown` as the study aid of `kind`, replacing any earlier one. */
export async function writeStudyAid(
  container: ContentContainer,
  kind: StudyAidKind,
  markdown: string,
): Promise<void> {
  await container.writeFile(
    studyAidPath(kind),
    new TextEncoder().encode(markdown),
    'text/markdown',
  );
}
