/**
 * Ask's conversations saved as Markdown: one file per chat in the
 * workspace's chats folder (`Chats/`, set up on the first answer), each
 * exchange appended as it settles. Cited sources become footnotes that link
 * the note, and reading a chat back turns them into citations again, so a
 * resumed conversation opens its notes the way a live one does.
 *
 * Saved chats are the model's words, not the person's notes, so Ask and the
 * other AI actions leave them out of the passages they send
 * (`chatDocumentPaths` in `chat-folders.ts`, which the shell loads up front).
 */

import {
  FsError,
  parseWorkspacePath,
  workspacePathDirname,
  workspacePathJoin,
  type FileSystemProviderV2,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  DEFAULT_CHATS_FOLDER_NAME,
  appendChatSection,
  chatSection,
  defaultFolderSettings,
  kindFoldersOf,
  markdownFileNameForTitle,
  numberedFileName,
  parseChatTranscript,
  readFolderSettings,
  writeFolderSettings,
  type KindFolder,
} from '@bendyline/docblocks/folders';
import {
  WORKSPACE_KNOWLEDGE_CATALOG_ID,
  WORKSPACE_KNOWLEDGE_NAME,
  workspacePassageUri,
  type AiChatEvidence,
  type AiChatKnowledge,
  type AiChatKnowledgeSource,
} from '@bendyline/docblocks/host';
import type { TaskGateway } from '../Tasks/task-operations.js';
import { citationsToFootnotes } from './knowledge-citations.js';
import { noteTitleFor, type AskTurn } from './workspace-ask.js';
import { workspaceCatalogId } from './workspace-grounding.js';

export type ChatStorage = Pick<
  FileSystemProviderV2,
  'readFile' | 'writeFile' | 'remove' | 'createDirectory' | 'stat' | 'capabilities'
>;

/** How a chat reaches one workspace's files. */
export interface ChatStore {
  /** Reads and appends; the open workspace's goes through an open editor. */
  readonly gateway: TaskGateway;
  /** For setting up the chats folder. */
  readonly storage: ChatStorage;
  /** The folders the index knows say what they are; empty for a workspace not open. */
  readonly kindFolders: readonly KindFolder[];
}

const MAX_FOLDER_ATTEMPTS = 50;
const MAX_NAME_ATTEMPTS = 200;

/**
 * The chats folder to save in: the one the index knows, else `Chats` (or
 * `Chats 2`, …) when storage already says it is one, else the first of
 * those names that is free, set up now.
 */
export async function ensureChatsFolder(store: ChatStore): Promise<WorkspacePath> {
  const known = kindFoldersOf(store.kindFolders, 'chats')[0];
  if (known) return known.path;
  for (let attempt = 1; attempt <= MAX_FOLDER_ATTEMPTS; attempt += 1) {
    const folder = parseWorkspacePath(
      attempt === 1 ? DEFAULT_CHATS_FOLDER_NAME : `${DEFAULT_CHATS_FOLDER_NAME} ${attempt}`,
    );
    const observed = await readFolderSettings(store.storage, folder);
    if (observed.status === 'ready' && observed.settings?.kind === 'chats') return folder;
    if (observed.status !== 'missing' || (await store.storage.stat(folder)) !== null) continue;
    try {
      await store.storage.createDirectory(folder, { createParents: true });
    } catch (error: unknown) {
      if (!(error instanceof FsError && error.code === 'already-exists')) throw error;
    }
    await writeFolderSettings(store.storage, folder, observed, defaultFolderSettings('chats'));
    return folder;
  }
  throw new Error(`Too many folders are already called ${DEFAULT_CHATS_FOLDER_NAME}.`);
}

/** The catalog names a turn's footnotes call its sources by. */
function catalogNames(knowledge: AiChatKnowledge | null): Map<string, string> {
  return new Map(
    knowledge?.outcome === 'used'
      ? knowledge.sources.map((source) => [source.catalogId, source.name])
      : [],
  );
}

/** The exchange as written after `document` in the file at `path`. */
function sectionFor(turn: AskTurn, document: string, path: string): string {
  const answer =
    turn.knowledge?.outcome === 'used'
      ? citationsToFootnotes(
          turn.answer,
          turn.knowledge.evidence,
          catalogNames(turn.knowledge),
          document,
          path,
        )
      : turn.answer;
  return chatSection(turn.question, answer);
}

async function createChat(store: ChatStore, turn: AskTurn): Promise<WorkspacePath> {
  const folder = await ensureChatsFolder(store);
  const name = markdownFileNameForTitle(noteTitleFor(turn.question), 'Chat');
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const path = workspacePathJoin(folder, numberedFileName(name, attempt));
    if (await store.gateway.exists(path)) continue;
    try {
      await store.gateway.create(path, sectionFor(turn, '', path));
      return path;
    } catch (error: unknown) {
      // Taken between the look and the write: try the next number.
      if (!(error instanceof FsError && error.code === 'already-exists')) throw error;
    }
  }
  throw new Error('Too many chats already have that name.');
}

/**
 * Save `turn` at the end of the chat file at `path`, or in a new chat file
 * named for its question when there is none (or it has gone). Whatever the
 * person wrote in the file meanwhile stays. Returns where it was saved.
 */
export async function saveChatTurn(
  store: ChatStore,
  path: string | null,
  turn: AskTurn,
): Promise<WorkspacePath> {
  if (path !== null) {
    const target = parseWorkspacePath(path);
    if (await store.gateway.exists(target)) {
      await store.gateway.rewrite(target, async (source) =>
        appendChatSection(source, sectionFor(turn, source, target)),
      );
      return target;
    }
  }
  return createChat(store, turn);
}

/** `href` (a relative Markdown link) from the folder holding `from`, as a workspace path. */
function resolveLink(from: WorkspacePath, href: string): WorkspacePath | null {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('/')) return null;
  const segments = workspacePathDirname(from).split('/').filter(Boolean);
  try {
    for (const raw of href.split(/[?#]/u)[0]!.split('/')) {
      const segment = decodeURIComponent(raw);
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (segments.length === 0) return null;
        segments.pop();
      } else segments.push(segment);
    }
    return parseWorkspacePath(segments.join('/'));
  } catch {
    return null;
  }
}

const NOTE_LINK = /^\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\), a note in this workspace\.?$/u;
const NOTE_NAME = /^(.+), a note in this workspace\.?$/u;
const CATALOG_ARTICLE = /^(.+), from the (.+) knowledge catalog\.?$/u;
const OTHER_SOURCES = 'Sources';

/** A footnote as the evidence a live turn would have carried. */
function evidenceFor(
  text: string,
  chatPath: WorkspacePath,
  catalogId: string,
): { readonly evidence: AiChatEvidence; readonly name: string } {
  const link = NOTE_LINK.exec(text);
  if (link) {
    const title = link[1]!.replace(/\\(.)/gu, '$1');
    const target = resolveLink(chatPath, link[2]!);
    const uri = target ? workspacePassageUri(catalogId, target, 1, 1) : null;
    return {
      evidence: {
        title,
        catalogId: WORKSPACE_KNOWLEDGE_CATALOG_ID,
        text: '',
        ...(uri ? { uri } : {}),
      },
      name: WORKSPACE_KNOWLEDGE_NAME,
    };
  }
  const note = NOTE_NAME.exec(text);
  if (note) {
    return {
      evidence: { title: note[1]!, catalogId: WORKSPACE_KNOWLEDGE_CATALOG_ID, text: '' },
      name: WORKSPACE_KNOWLEDGE_NAME,
    };
  }
  const article = CATALOG_ARTICLE.exec(text);
  if (article) {
    return {
      evidence: { title: article[1]!, catalogId: article[2]!, text: '' },
      name: article[2]!,
    };
  }
  return { evidence: { title: text, catalogId: OTHER_SOURCES, text: '' }, name: OTHER_SOURCES };
}

/** A run of footnote references, `[^a]` or `[^a][^b]`. */
const REFERENCES = /(?:\[\^([^\]\s]+)\])+/gu;

/** One saved answer with its footnotes as `[n]` citations into knowledge. */
function citedAnswer(
  answer: string,
  footnotes: ReadonlyMap<string, string>,
  chatPath: WorkspacePath,
  catalogId: string,
): { readonly answer: string; readonly knowledge: AiChatKnowledge | null } {
  const numbers = new Map<string, number>();
  const evidence: AiChatEvidence[] = [];
  const sources = new Map<string, { name: string; titles: string[] }>();
  const cited = answer.replace(REFERENCES, (run: string, _label: string, offset: number) => {
    const found: number[] = [];
    for (const match of run.matchAll(/\[\^([^\]\s]+)\]/gu)) {
      const label = match[1]!;
      const text = footnotes.get(label);
      if (text === undefined) continue;
      let n = numbers.get(label);
      if (n === undefined) {
        const { evidence: passage, name } = evidenceFor(text, chatPath, catalogId);
        evidence.push(passage);
        n = evidence.length;
        numbers.set(label, n);
        const source = sources.get(passage.catalogId) ?? { name, titles: [] };
        if (!source.titles.includes(passage.title)) source.titles.push(passage.title);
        sources.set(passage.catalogId, source);
      }
      found.push(n);
    }
    if (found.length === 0) return '';
    // A citation reads as one only after a space or punctuation, not straight after a word.
    const before = offset > 0 ? answer[offset - 1]! : ' ';
    return `${/[\p{L}\p{N}_\]]/u.test(before) ? ' ' : ''}[${found.join(', ')}]`;
  });
  if (evidence.length === 0) return { answer: cited, knowledge: null };
  const knowledgeSources: AiChatKnowledgeSource[] = [...sources].map(([id, source]) => ({
    catalogId: id,
    name: source.name,
    titles: source.titles,
  }));
  return { answer: cited, knowledge: { outcome: 'used', sources: knowledgeSources, evidence } };
}

/**
 * The conversation saved in `source` (the chat file at `path` in workspace
 * `workspaceId`) as finished turns to show and continue; null when the file
 * holds no conversation.
 */
export function chatTurnsFromMarkdown(
  source: string,
  path: string,
  workspaceId: string,
): AskTurn[] | null {
  const transcript = parseChatTranscript(source);
  if (!transcript) return null;
  const chatPath = parseWorkspacePath(path);
  const catalogId = workspaceCatalogId(workspaceId);
  return transcript.turns.map((turn, index) => {
    const { answer, knowledge } = citedAnswer(
      turn.answer,
      transcript.footnotes,
      chatPath,
      catalogId,
    );
    return {
      id: index + 1,
      question: turn.question,
      answer,
      status: 'done',
      knowledge,
      facts: null,
      error: null,
      truncated: false,
    };
  });
}
