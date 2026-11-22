/**
 * "Ask your workspace": questions answered from the person's own notes, with
 * numbered citations that open the note they came from.
 *
 * Each turn finds passages by meaning for the question alone, sends them with
 * the last few turns, and checks the answer's details against what the model
 * was shown. A turn that finds nothing never reaches the model: an answer
 * with no notes behind it would come from the model's memory. For the same
 * reason a turn stops when the host reports that none of its passages were
 * used (Gezel's relevance model found none of them answers the question).
 *
 * The session is a small store rather than React state, so a streaming answer
 * re-renders the panel and not the whole shell, and a run outlives the editor
 * remounting when a cited note is opened.
 */

import type {
  AiChatEvent,
  AiChatKnowledge,
  AiChatMessage,
  AiChatRequest,
  AiChatProgress,
  AiFactCheck,
  AiWorkspacePassage,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { chatOnce } from './chat-once.js';
import { factCheckRequest, mergeAiKnowledge } from './ai-knowledge.js';
import { citationParts, stripCitationMarkers } from './knowledge-citations.js';

export const ASK_SYSTEM_PROMPT =
  "You answer questions about the person's own notes. Use the reference passages, which " +
  'come from their notes and knowledge catalogs, and nothing you remember. Answer in plain, ' +
  'concise Markdown. If the passages do not answer the question, say so in one sentence and ' +
  'do not guess.';

/** Earlier turns sent with a question, so a follow-up can say "it". */
const HISTORY_TURNS = 3;
const HISTORY_ANSWER_CHARACTERS = 1_500;
export const ASK_QUESTION_CHARACTERS = 2_000;

export type AskTurnStatus = 'searching' | 'answering' | 'done' | 'stopped' | 'nothing' | 'error';

export interface AskTurn {
  readonly id: number;
  readonly question: string;
  /** Markdown with `[n]` citations into `knowledge.evidence`. */
  readonly answer: string;
  readonly status: AskTurnStatus;
  readonly knowledge: AiChatKnowledge | null;
  readonly facts: AiFactCheck | null;
  readonly error: string | null;
  /** The answer stopped at the model's length limit. */
  readonly truncated: boolean;
}

/** The request for `question`, after the session's finished turns. */
export function askRequest(
  history: readonly AskTurn[],
  question: string,
  passages: readonly AiWorkspacePassage[],
): AiChatRequest {
  const messages: AiChatMessage[] = [{ role: 'system', content: ASK_SYSTEM_PROMPT }];
  const earlier = history
    .filter((turn) => turn.status === 'done' && turn.answer.trim())
    .slice(-HISTORY_TURNS);
  for (const turn of earlier) {
    messages.push({ role: 'user', content: turn.question });
    // Its numbers pointed at that turn's passages, which this one does not have.
    messages.push({
      role: 'assistant',
      content: stripCitationMarkers(turn.answer).slice(0, HISTORY_ANSWER_CHARACTERS),
    });
  }
  messages.push({ role: 'user', content: question });
  return {
    messages,
    purpose: 'chat',
    knowledgeQuery: question,
    knowledgeCitations: true,
    ...(passages.length ? { workspacePassages: [...passages] } : {}),
  };
}

/** A note title for a question: no trailing mark, no path characters, short. */
export function noteTitleFor(question: string): string {
  const title = question
    .replace(/[\\/:*?"<>|#^[\]\p{Cc}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return title || 'Answer';
}

/** One run of an answer's text: plain, emphasised, code, or a citation. */
export type AnswerInline =
  | { readonly kind: 'text' | 'strong' | 'em' | 'code'; readonly text: string }
  | { readonly kind: 'cite'; readonly numbers: readonly number[] };

export type AnswerBlock =
  | { readonly kind: 'paragraph' | 'heading'; readonly inlines: readonly AnswerInline[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly (readonly AnswerInline[])[];
    };

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/u;

function inlines(text: string): AnswerInline[] {
  const out: AnswerInline[] = [];
  for (const part of citationParts(text)) {
    if (typeof part !== 'string') {
      out.push({ kind: 'cite', numbers: part });
      continue;
    }
    for (const piece of part.split(INLINE)) {
      if (!piece) continue;
      if (piece.startsWith('`')) out.push({ kind: 'code', text: piece.slice(1, -1) });
      else if (piece.startsWith('**') || piece.startsWith('__')) {
        out.push({ kind: 'strong', text: piece.slice(2, -2) });
      } else if (INLINE.test(piece) && /^[*_]/u.test(piece)) {
        out.push({ kind: 'em', text: piece.slice(1, -1) });
      } else out.push({ kind: 'text', text: piece });
    }
  }
  return out;
}

const LIST_ITEM = /^\s{0,3}(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u;

/**
 * An answer's Markdown as blocks to render: paragraphs, headings and lists,
 * with emphasis, code and citations inline. Anything else reads as text, so
 * nothing a model writes becomes markup.
 */
export function answerBlocks(markdown: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inlines: inlines(paragraph.join(' ')) });
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(inlines) });
    }
    paragraph = [];
    list = null;
  };
  for (const line of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', inlines: inlines(heading[1] ?? '') });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[3] ?? '');
      continue;
    }
    if (list && /^\s+\S/u.test(line)) {
      // A wrapped list item continues on an indented line.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

export interface AskGeneration {
  readonly progress: AiChatProgress | null;
  readonly startedAt: number;
  readonly lastActivityAt: number;
}

export interface AskSnapshot {
  readonly turns: readonly AskTurn[];
  /** Progress of the answer being written; null otherwise. */
  readonly generation: AskGeneration | null;
}

export interface AskDependencies {
  readonly ai: Pick<DocBlocksHostAiAPI, 'chat' | 'checkFacts'>;
  /** Passages for the question, found by meaning; empty when none are. */
  readonly findPassages: (question: string) => Promise<readonly AiWorkspacePassage[]>;
}

export interface WorkspaceAskSession {
  getSnapshot(): AskSnapshot;
  subscribe(listener: () => void): () => void;
  /** Point the session at the shell's current AI and index. */
  configure(dependencies: AskDependencies): void;
  /** Ask `question`; ignored while a turn is running or when it is blank. */
  ask(question: string): Promise<void>;
  stop(): void;
  /** Forget the session's turns, stopping a running one. */
  clear(): void;
  /** The question being typed, kept while the panel remounts with the editor. */
  draft: string;
}

const EMPTY: AskSnapshot = { turns: [], generation: null };

export function createWorkspaceAskSession(): WorkspaceAskSession {
  let snapshot = EMPTY;
  let dependencies: AskDependencies | null = null;
  let controller: AbortController | null = null;
  let nextId = 1;
  const listeners = new Set<() => void>();
  const publish = (next: AskSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const update = (id: number, change: Partial<AskTurn>) =>
    publish({
      ...snapshot,
      turns: snapshot.turns.map((turn) => (turn.id === id ? { ...turn, ...change } : turn)),
    });
  const running = () =>
    snapshot.turns.some((turn) => turn.status === 'searching' || turn.status === 'answering');

  return {
    draft: '',
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure(next) {
      dependencies = next;
    },
    async ask(raw) {
      const question = raw.trim().slice(0, ASK_QUESTION_CHARACTERS);
      const deps = dependencies;
      if (!question || !deps || running()) return;
      const history = snapshot.turns;
      const id = nextId++;
      const run = new AbortController();
      controller = run;
      publish({
        ...snapshot,
        turns: [
          ...snapshot.turns,
          {
            id,
            question,
            answer: '',
            status: 'searching',
            knowledge: null,
            facts: null,
            error: null,
            truncated: false,
          },
        ],
      });
      const passages = await deps.findPassages(question).catch(() => []);
      if (run.signal.aborted) return;
      if (passages.length === 0) {
        update(id, { status: 'nothing' });
        controller = null;
        return;
      }
      const startedAt = Date.now();
      update(id, { status: 'answering' });
      publish({
        ...snapshot,
        generation: { progress: null, startedAt, lastActivityAt: startedAt },
      });
      let answer = '';
      let knowledge: AiChatKnowledge | null = null;
      // Gezel's relevance model judges the passages again and may find none
      // of them answers the question; the model would then answer from memory.
      let judgedIrrelevant = false;
      const onEvent = (event: AiChatEvent) => {
        if (run.signal.aborted) return;
        const now = Date.now();
        if (event.kind === 'knowledge' && event.knowledge.outcome === 'none') {
          judgedIrrelevant = true;
          run.abort();
          return;
        }
        if (event.kind === 'knowledge') {
          knowledge = mergeAiKnowledge(knowledge, event.knowledge);
          update(id, { knowledge });
        } else if (event.kind === 'delta') {
          answer += event.text;
          update(id, { answer });
        } else if (event.kind === 'progress') {
          publish({
            ...snapshot,
            generation: { progress: event.progress, startedAt, lastActivityAt: now },
          });
          return;
        }
        if (snapshot.generation) {
          publish({ ...snapshot, generation: { ...snapshot.generation, lastActivityAt: now } });
        }
      };
      const outcome = await chatOnce(
        deps.ai,
        askRequest(history, question, passages),
        run.signal,
        onEvent,
      );
      if (controller === run) controller = null;
      if (judgedIrrelevant) {
        publish({ ...snapshot, generation: null });
        update(id, { status: 'nothing' });
        return;
      }
      if (run.signal.aborted && outcome.kind !== 'ok') return;
      publish({ ...snapshot, generation: null });
      if (outcome.kind === 'cancelled') {
        update(id, { status: 'stopped' });
        return;
      }
      if (outcome.kind === 'error') {
        update(id, { status: 'error', error: outcome.error.message });
        return;
      }
      const text = outcome.text.trim() || answer.trim();
      update(id, { status: 'done', answer: text, truncated: outcome.truncated });
      const request = deps.ai.checkFacts ? factCheckRequest(text, knowledge, question, true) : null;
      if (!request || !deps.ai.checkFacts) return;
      const checked = await deps.ai.checkFacts(request).catch(() => null);
      if (checked?.ok && snapshot.turns.some((turn) => turn.id === id)) {
        update(id, { facts: checked.value });
      }
    },
    stop() {
      controller?.abort();
      controller = null;
      const stopped = snapshot.turns.map((turn) =>
        turn.status === 'searching' || turn.status === 'answering'
          ? { ...turn, status: 'stopped' as const }
          : turn,
      );
      publish({ turns: stopped, generation: null });
    },
    clear() {
      controller?.abort();
      controller = null;
      publish(EMPTY);
    },
  };
}
