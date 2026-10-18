/**
 * Turn what the model wrote into the saved study aid documents.
 *
 * Quiz questions and flashcards are compiled into Squisq's card syntax here,
 * never written by the model: every card is a `##` heading carrying an
 * explicit `{study=…}` marker, and every piece of model text is passed
 * through the diagram sanitizer so it cannot open a heading, an attribute
 * block, or a list. Each card is then read back through Squisq's own
 * `materializeFlashcards` and kept only if it comes out as exactly the card
 * that was meant.
 */

import { markdownToDoc, materializeFlashcards } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { sanitizeGeneratedMarkdown } from './ai-assistant.js';
import { stripReasoning } from './ai-json.js';
import { contentTokens, extractNumbers } from './diagram-grounding.js';
import { bodyLine, cleanLabel } from './diagram-sanitize.js';
import {
  STUDY_AID_LABELS,
  withStudyAidFrontmatter,
  type StudyAidKind,
  type StudyAidProvenance,
} from './study-aids.js';
import { itemKey, type FlashcardItem, type QuizItem } from './study-prompts.js';

const QUESTION_CHARACTERS = 300;
const CHOICE_CHARACTERS = 160;
const EXPLANATION_CHARACTERS = 400;
const FRONT_CHARACTERS = 200;
const BACK_CHARACTERS = 600;
const TITLE_CHARACTERS = 160;

/** Sanitized heading text that cannot end in a closing `#` sequence. */
function headingText(value: string, max: number): string {
  return cleanLabel(value, max).replace(/(^|\s)(#+)$/u, '$1\\$2');
}

/** FNV-1a: a stable seed from text. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** `items` in an order fixed by `seed` (mulberry32 driving Fisher–Yates). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other] as T, out[index] as T];
  }
  return out;
}

/**
 * One multiple-choice card: the label heading carries the marker and the
 * explanation, then the question, then each choice with the correct one
 * marked. Choices are shuffled by the question's hash, so the answer is not
 * always first and the same question always comes out the same way.
 */
export function renderQuizCard(item: QuizItem, number: number): string | null {
  const question = headingText(item.question, QUESTION_CHARACTERS);
  const correct = headingText(item.correct, CHOICE_CHARACTERS);
  if (!question || !correct) return null;
  const seen = new Set([itemKey(correct)]);
  const wrong: string[] = [];
  for (const choice of item.wrong.map((text) => headingText(text, CHOICE_CHARACTERS))) {
    const key = itemKey(choice);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    wrong.push(choice);
  }
  if (wrong.length < 2) return null;
  const choices = shuffled(
    [{ text: correct, correct: true }, ...wrong.map((text) => ({ text, correct: false }))],
    seedOf(question),
  );
  const lines = [`## Question ${String(number)} {study=multiple-choice-flashcard}`, ''];
  const why = item.why ? bodyLine(item.why, EXPLANATION_CHARACTERS) : '';
  if (why) lines.push(why, '');
  lines.push(`### ${question}`);
  for (const choice of choices) {
    lines.push('', `### ${choice.text}${choice.correct ? ' {correct=true}' : ''}`);
  }
  return lines.join('\n');
}

/** One basic card: the front as the heading, the back as its body. */
export function renderFlashcard(item: FlashcardItem): string | null {
  const front = headingText(item.front, FRONT_CHARACTERS);
  const back = bodyLine(item.back, BACK_CHARACTERS);
  if (!front || !back) return null;
  return `## ${front} {study=flashcard}\n\n${back}`;
}

/**
 * Whether `markdown` reads back through Squisq as exactly one card of `kind`
 * with no errors, and, for a multiple-choice card, with `choices` choices of
 * which exactly one is correct.
 */
export function cardIsValid(
  markdown: string,
  kind: 'basic' | 'multiple-choice',
  choices = 0,
): boolean {
  let deck: ReturnType<typeof materializeFlashcards>;
  try {
    deck = materializeFlashcards(markdownToDoc(parseMarkdown(markdown)), { source: 'explicit' });
  } catch {
    return false;
  }
  const [card] = deck.cards;
  if (deck.cards.length !== 1 || !card || card.kind !== kind) return false;
  if (deck.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return false;
  if (kind === 'basic') return true;
  return (
    card.choices?.length === choices && card.choices.filter((choice) => choice.correct).length === 1
  );
}

/** Whether every number in `answer` is one `material` states. */
function numbersStated(answer: string, material: string): boolean {
  const known = extractNumbers(material);
  return extractNumbers(answer).every((value) =>
    known.some((stated) => Math.abs(stated - value) <= 1e-9 * Math.max(1, Math.abs(value))),
  );
}

/** Whether `claim` shares at least one word with `material`. */
function sharesWords(claim: string, material: string): boolean {
  const words = contentTokens(claim);
  if (words.size === 0) return true;
  const stated = contentTokens(material);
  return [...words].some((word) => stated.has(word));
}

/**
 * Whether a question sticks to its passage: the correct answer's numbers
 * are all stated there, and the question and answer share a word with it.
 * Wrong answers are meant to be unsupported, so they are not checked.
 */
export function quizItemGrounded(item: QuizItem, material: string): boolean {
  return (
    numbersStated(item.correct, material) &&
    sharesWords(`${item.question} ${item.correct}`, material)
  );
}

/** Whether a flashcard sticks to its passage, by the same tests as a question. */
export function flashcardGrounded(item: FlashcardItem, material: string): boolean {
  return numbersStated(item.back, material) && sharesWords(`${item.front} ${item.back}`, material);
}

/**
 * The model's summary as the body of the saved document: wrapper fences and
 * reasoning removed, a leading title dropped (the compiler writes its own),
 * and other headings demoted below the title.
 */
export function compileSummaryBody(reply: string): string {
  const lines = sanitizeGeneratedMarkdown(stripReasoning(reply)).split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker.charAt(0);
      else if (marker.charAt(0) === fence) fence = null;
      out.push(line);
      continue;
    }
    const heading = fence === null ? /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line) : null;
    if (heading) {
      if (out.every((earlier) => !earlier.trim())) continue;
      out.push(`### ${(heading[1] ?? '').replace(/\s+#+\s*$/u, '').trim()}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

function studyAidTitle(kind: StudyAidKind, documentTitle: string): string {
  return headingText(
    `${STUDY_AID_LABELS[kind].title}: ${documentTitle.trim() || 'Untitled'}`,
    TITLE_CHARACTERS,
  );
}

/** The saved summary: frontmatter, a title, and the compiled body. */
export function assembleSummary(
  body: string,
  documentTitle: string,
  provenance: StudyAidProvenance,
): string {
  const title = studyAidTitle('summary', documentTitle);
  return withStudyAidFrontmatter(`# ${title}\n\n${body}\n`, title, provenance);
}

/** The saved quiz or flashcard deck: frontmatter, then the cards. */
export function assembleDeck(
  kind: 'quiz' | 'flashcards',
  cards: readonly string[],
  documentTitle: string,
  provenance: StudyAidProvenance,
): string {
  const title = studyAidTitle(kind, documentTitle);
  return withStudyAidFrontmatter(`${cards.join('\n\n')}\n`, title, provenance);
}
