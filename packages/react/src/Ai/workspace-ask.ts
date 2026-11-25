/**
 * Ask: a conversation with the person's AI, grounded in their own notes when
 * they bear on it, with numbered citations that open the note they came from.
 *
 * Every message reaches the model. Each turn first finds passages by meaning
 * for the message alone and sends them, with the earlier turns, as reference
 * material; when none are found, or Gezel's relevance model finds none of
 * them answers it, the model answers as any chat would. Notes are enrichment,
 * never a gate. An answer that drew on sources has its details checked
 * against them.
 *
 * The session is a small store rather than React state, so a streaming answer
 * re-renders the panel and not the whole shell, and a run outlives the editor
 * remounting when a cited note is opened. Each settled turn is handed to the
 * host to save (`AskDependencies.save`), one at a time, in order.
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
  'You are a helpful assistant in DocBlocks, where the person keeps their notes as Markdown. ' +
  'Talk with them naturally and answer in plain, concise Markdown. A message may come with ' +
  "reference passages from the person's notes and knowledge catalogs: when they bear on it, " +
  'answer from them first. When they do not, or there are none, answer from what you know, ' +
  'and never say their notes contain something the passages do not show. If you are not sure ' +
  'of something, say so.';

/** Earlier turns sent with a message, so a follow-up can say "it". */
const HISTORY_TURNS = 8;
const HISTORY_ANSWER_CHARACTERS = 1_500;
/** All earlier turns together, so a long chat leaves room for passages on a small model. */
const HISTORY_CHARACTERS = 8_000;
export const ASK_QUESTION_CHARACTERS = 2_000;

export type AskTurnStatus = 'searching' | 'answering' | 'done' | 'stopped' | 'error';

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

/** How task facts are introduced to the model, when a question carries them. */
export const ASK_TASK_FACTS_PROMPT =
  "Facts from the person's task list, read from their files just now. They are exact: answer " +
  'questions about what is due, overdue or finished from them, and do not add tasks they do not list.';

/** The request for `question`, after the session's finished turns. */
export function askRequest(
  history: readonly AskTurn[],
  question: string,
  passages: readonly AiWorkspacePassage[],
  facts: string | null = null,
): AiChatRequest {
  const messages: AiChatMessage[] = [{ role: 'system', content: ASK_SYSTEM_PROMPT }];
  if (facts) messages.push({ role: 'system', content: `${ASK_TASK_FACTS_PROMPT}\n\n${facts}` });
  const earlier: AiChatMessage[][] = [];
  let characters = 0;
  for (const turn of history
    .filter((entry) => entry.status === 'done' && entry.answer.trim())
    .slice(-HISTORY_TURNS)
    .reverse()) {
    // Its numbers pointed at that turn's passages, which this one does not have.
    const answer = stripCitationMarkers(turn.answer).slice(0, HISTORY_ANSWER_CHARACTERS);
    characters += turn.question.length + answer.length;
    // The newest turns are kept; the oldest give way first.
    if (characters > HISTORY_CHARACTERS && earlier.length > 0) break;
    earlier.unshift([
      { role: 'user', content: turn.question },
      { role: 'assistant', content: answer },
    ]);
  }
  messages.push(...earlier.flat());
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

/** Where a conversation is saved: a chat file in the workspace it started in. */
export interface AskChat {
  readonly workspaceId: string;
  readonly path: string;
}

export interface AskSnapshot {
  readonly turns: readonly AskTurn[];
  /** Progress of the answer being written; null otherwise. */
  readonly generation: AskGeneration | null;
  /** The chat file this conversation is saved in; null until its first answer is saved. */
  readonly chat: AskChat | null;
}

export interface AskDependencies {
  readonly ai: Pick<DocBlocksHostAiAPI, 'chat' | 'checkFacts'>;
  /** Passages for the question, found by meaning; empty when none are. */
  readonly findPassages: (question: string) => Promise<readonly AiWorkspacePassage[]>;
  /** Facts from the task list to answer from too; null or absent when there are none. */
  readonly facts?: () => string | null;
  /**
   * Save a settled turn (answered, or stopped part way with some answer) to
   * the conversation's chat file, `chat`, or a new one when it is null.
   * Resolves with where it was saved, or null when it was not. Calls never
   * overlap: the next waits for this one.
   */
  readonly save?: (turn: AskTurn, chat: AskChat | null) => Promise<AskChat | null>;
}

export interface WorkspaceAskSession {
  getSnapshot(): AskSnapshot;
  subscribe(listener: () => void): () => void;
  /** Point the session at the shell's current AI and index. */
  configure(dependencies: AskDependencies): void;
  /** Ask `question`; ignored while a turn is running or when it is blank. */
  ask(question: string): Promise<void>;
  stop(): void;
  /** Forget the session's turns, stopping a running one; the next answer starts a new chat. */
  clear(): void;
  /** Show a saved conversation, stopping a running one; new turns are added to its file. */
  restore(turns: readonly AskTurn[], chat: AskChat): void;
  /** The chat file moved (renamed) or is gone (null: the next answer starts a new one). */
  moveChat(from: string, to: string | null): void;
  /** The question being typed, kept while the panel remounts with the editor. */
  draft: string;
}

const EMPTY: AskSnapshot = { turns: [], generation: null, chat: null };

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
  /** Bumped by clear and restore, so a save for the conversation before is not adopted. */
  let conversation = 0;
  let saving: Promise<void> = Promise.resolve();
  const save = (turn: AskTurn, deps: AskDependencies) => {
    const store = deps.save;
    if (!store) return;
    const of = conversation;
    saving = saving
      .then(async () => {
        if (of !== conversation) return;
        const chat = await store(turn, snapshot.chat);
        if (chat && of === conversation) publish({ ...snapshot, chat });
      })
      .catch(() => undefined);
  };

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
      const facts = deps.facts?.() ?? null;
      const startedAt = Date.now();
      update(id, { status: 'answering' });
      publish({
        ...snapshot,
        generation: { progress: null, startedAt, lastActivityAt: startedAt },
      });
      let answer = '';
      let knowledge: AiChatKnowledge | null = null;
      const onEvent = (event: AiChatEvent) => {
        if (run.signal.aborted) return;
        const now = Date.now();
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
        askRequest(history, question, passages, facts),
        run.signal,
        onEvent,
      );
      if (controller === run) controller = null;
      if (run.signal.aborted && outcome.kind !== 'ok') {
        // Stopped by the person: what was written so far is kept with the chat.
        const stopped = snapshot.turns.find((entry) => entry.id === id);
        if (stopped?.status === 'stopped' && stopped.answer.trim()) save(stopped, deps);
        return;
      }
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
      const settled = snapshot.turns.find((entry) => entry.id === id);
      if (settled && text) save(settled, deps);
      // Only an answer that drew on sources is checked against them: a chat
      // answer from what the model knows would flag every detail.
      const sourced = (knowledge as AiChatKnowledge | null)?.outcome === 'used';
      const request =
        sourced && deps.ai.checkFacts ? factCheckRequest(text, knowledge, question, true) : null;
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
      publish({ ...snapshot, turns: stopped, generation: null });
    },
    clear() {
      controller?.abort();
      controller = null;
      conversation += 1;
      publish(EMPTY);
    },
    restore(turns, chat) {
      controller?.abort();
      controller = null;
      conversation += 1;
      const ids = turns.map(() => nextId++);
      publish({
        turns: turns.map((turn, index) => ({ ...turn, id: ids[index]! })),
        generation: null,
        chat,
      });
    },
    moveChat(from, to) {
      if (snapshot.chat?.path !== from) return;
      if (to === null) conversation += 1;
      publish({ ...snapshot, chat: to === null ? null : { ...snapshot.chat, path: to } });
    },
  };
}
