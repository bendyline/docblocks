import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import {
  parseWorkspacePassageUri,
  type AiChatEvidence,
  type AiWorkspacePassage,
  type DocBlocksHostAiAPI,
  type WorkspacePassageReference,
} from '@bendyline/docblocks/host';

import { ChatsIcon, CloseIcon } from '../icons.js';
import { AiGenerationStatus } from './AiGenerationStatus.js';
import { AskChatList, type AskChats } from './AskChatList.js';
import { AiFactsIndicator, AiKnowledgeIndicator } from './AiKnowledgeIndicator.js';
import { AllowEditsToggle, TurnProposalsBlock } from './AskProposals.js';
import { resetAskProposals, type AskActions } from './ask-proposals.js';
import { citationsToFootnotes, stripCitationMarkers } from './knowledge-citations.js';
import {
  ASK_QUESTION_CHARACTERS,
  answerBlocks,
  createWorkspaceAskSession,
  noteTitleFor,
  type AnswerInline,
  type AskDependencies,
  type AskTurn,
  type WorkspaceAskSession,
} from './workspace-ask.js';

/** Why answers do not draw on the workspace yet, and the one step that lets them. */
export type AskNotice =
  | { readonly kind: 'grounding-off'; readonly remote: boolean; readonly onAllow: () => void }
  | { readonly kind: 'semantic-off'; readonly onAllow: () => void }
  | { readonly kind: 'not-ready'; readonly message: string; readonly onOpenSettings?: () => void };

export interface AiAskPanelProps {
  /**
   * Where the conversation lives: the shell's, so it outlives this panel when
   * the editor remounts for another note. Filled on first open.
   */
  sessionHolder: { current: WorkspaceAskSession | null };
  ai: Pick<DocBlocksHostAiAPI, 'chat' | 'checkFacts'>;
  /** Passages for a question, found by meaning across the workspace. */
  findPassages: (question: string) => Promise<readonly AiWorkspacePassage[]>;
  /** Null when answers can draw on the workspace. The chat works either way. */
  notice: AskNotice | null;
  /** How much of the workspace meaning search covers, while that is incomplete. */
  coverage: string | null;
  /** Saved chats in the open workspace; absent where chats are not saved. */
  chats?: AskChats;
  /**
   * Where the chat list shows: behind a Chats button (`toggle`, the side
   * panel), or beside the conversation, with the button only when the page
   * is too narrow for both (`beside`, the Ask page).
   */
  chatList?: 'toggle' | 'beside';
  /** Opens a cited note at its lines; `passage` is the text the model was shown. */
  onOpenNote: (reference: WorkspacePassageReference, passage: string) => void;
  /** Writes a new note named for `title`, built for the path it lands at, and opens it. */
  onSaveNote: (title: string, markdownFor: (path: string) => string) => Promise<void>;
  onClose: () => void;
  /**
   * Inside the editor (the side panel): answers can be inserted into the
   * document. False for the Ask page, where there is no document to insert into.
   */
  inEditor?: boolean;
  /** Facts from the task list to answer from, alongside the notes. */
  facts?: () => string | null;
  /** Saves each settled turn to the conversation's chat file; absent: chats are not saved. */
  save?: AskDependencies['save'];
  /**
   * Carries out the tasks, notes and edits Ask suggests after an answer, once
   * the person confirms each. Absent: no suggestions are offered.
   */
  actions?: AskActions;
}

/** Inserting an answer into the open document; null where there is none. */
interface AnswerInsert {
  readonly markdownSource: string;
  readonly fileName: string | null;
  readonly insert: (markdown: string) => boolean;
}

const AnswerInsertContext = createContext<AnswerInsert | null>(null);

/** Provides insertion from the editor the panel is docked in. */
function EditorAnswerInsert({ children }: { children: ReactNode }) {
  const { insertBlockAfterCursor, markdownSource, fileName } = useEditorContext();
  const value = useMemo<AnswerInsert>(
    () => ({
      markdownSource,
      fileName: fileName ?? null,
      insert: (markdown) => insertBlockAfterCursor(() => markdown, { placement: 'afterBlock' }),
    }),
    [insertBlockAfterCursor, markdownSource, fileName],
  );
  return <AnswerInsertContext.Provider value={value}>{children}</AnswerInsertContext.Provider>;
}

function Inline({
  part,
  evidence,
  onCite,
}: {
  part: AnswerInline;
  evidence: readonly AiChatEvidence[];
  onCite: (n: number) => void;
}) {
  if (part.kind === 'cite') {
    return (
      <span className="db-ai-ask-cites">
        {part.numbers.map((n) => {
          const passage = evidence[n - 1];
          if (!passage) return null;
          const note = passage.uri ? parseWorkspacePassageUri(passage.uri) : null;
          const label = `Source ${n}: ${passage.title || 'untitled'}`;
          return note ? (
            <button
              key={n}
              type="button"
              className="db-ai-ask-cite"
              aria-label={`${label}. Open the note.`}
              title={passage.title}
              onClick={() => onCite(n)}
            >
              {n}
            </button>
          ) : (
            <span key={n} className="db-ai-ask-cite" title={passage.title} aria-label={label}>
              {n}
            </span>
          );
        })}
      </span>
    );
  }
  if (part.kind === 'strong') return <strong>{part.text}</strong>;
  if (part.kind === 'em') return <em>{part.text}</em>;
  if (part.kind === 'code') return <code>{part.text}</code>;
  return <>{part.text}</>;
}

function Answer({
  turn,
  onOpenNote,
}: {
  turn: AskTurn;
  onOpenNote: AiAskPanelProps['onOpenNote'];
}) {
  const evidence = turn.knowledge?.outcome === 'used' ? turn.knowledge.evidence : [];
  const onCite = (n: number) => {
    const passage = evidence[n - 1];
    const note = passage?.uri ? parseWorkspacePassageUri(passage.uri) : null;
    if (passage && note) onOpenNote(note, passage.text);
  };
  const render = (parts: readonly AnswerInline[]) =>
    parts.map((part, index) => (
      <Inline key={index} part={part} evidence={evidence} onCite={onCite} />
    ));
  return (
    <div className="db-ai-ask-answer">
      {answerBlocks(turn.answer).map((block, index) => {
        if (block.kind === 'list') {
          const items = block.items.map((item, at) => <li key={at}>{render(item)}</li>);
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
        }
        return block.kind === 'heading' ? (
          <h3 key={index}>{render(block.inlines)}</h3>
        ) : (
          <p key={index}>{render(block.inlines)}</p>
        );
      })}
    </div>
  );
}

function TurnActions({
  turn,
  onSaveNote,
}: {
  turn: AskTurn;
  onSaveNote: AiAskPanelProps['onSaveNote'];
}) {
  const editor = useContext(AnswerInsertContext);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const used = turn.knowledge?.outcome === 'used' ? turn.knowledge : null;
  const names = new Map(used?.sources.map((source) => [source.catalogId, source.name]) ?? []);
  const withSources = (document: string, path: string | null) =>
    used
      ? citationsToFootnotes(turn.answer, used.evidence, names, document, path)
      : stripCitationMarkers(turn.answer);

  const insert = () => {
    if (!editor) return;
    const markdown = withSources(editor.markdownSource, editor.fileName);
    const inserted = editor.insert(markdown);
    setMessage(
      inserted
        ? 'Inserted after the block holding the cursor.'
        : 'Switch to Write or Source to insert the answer.',
    );
  };
  const save = async () => {
    setSaving(true);
    setMessage(null);
    const title = noteTitleFor(turn.question);
    try {
      await onSaveNote(title, (path) => `# ${title}\n\n${withSources('', path)}\n`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'The note could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="db-ai-ask-actions">
      {editor && (
        <button type="button" onClick={insert}>
          Insert into document
        </button>
      )}
      <button type="button" disabled={saving} onClick={() => void save()}>
        Save as note
      </button>
      {message && (
        <p className="db-ai-note" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

function NoticeBlock({ notice }: { notice: AskNotice }) {
  if (notice.kind === 'grounding-off') {
    return (
      <div className="db-ai-ask-notice">
        <p>
          Answers do not draw on this workspace yet.{' '}
          {notice.remote
            ? 'Your AI provider runs remotely, so passages from your notes would be sent to it.'
            : 'Your AI runs on this device, so your notes stay here.'}
        </p>
        <button type="button" onClick={notice.onAllow}>
          Use this workspace in AI answers
        </button>
      </div>
    );
  }
  if (notice.kind === 'semantic-off') {
    return (
      <div className="db-ai-ask-notice">
        <p>
          Answers draw on notes found by meaning, and search by meaning is off, so they come from
          the AI alone.
        </p>
        <button type="button" onClick={notice.onAllow}>
          Turn on search by meaning
        </button>
      </div>
    );
  }
  return (
    <div className="db-ai-ask-notice">
      <p>{notice.message}</p>
      {notice.onOpenSettings && (
        <button type="button" onClick={notice.onOpenSettings}>
          Open Search settings
        </button>
      )}
    </div>
  );
}

/**
 * Ask: a chat with the person's AI, drawing on their notes where they bear on
 * it and citing the notes it used. Lives beside the editor and as a page; the
 * session it shows belongs to the shell, so opening a cited note keeps the
 * conversation, and each answer is saved to the chat's file as it settles.
 */
export function AiAskPanel({
  sessionHolder,
  ai,
  findPassages,
  notice,
  coverage,
  chats,
  chatList = 'toggle',
  onOpenNote,
  onSaveNote,
  onClose,
  inEditor = true,
  facts,
  save,
  actions,
}: AiAskPanelProps) {
  const session = useMemo(
    () => (sessionHolder.current ??= createWorkspaceAskSession()),
    [sessionHolder],
  );
  // Before any question can be asked, and again whenever the shell's AI changes.
  session.configure({ ai, findPassages, ...(facts ? { facts } : {}), ...(save ? { save } : {}) });
  const { turns, generation, chat } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [showChats, setShowChats] = useState(false);
  const [draft, setDraftState] = useState(session.draft);
  const setDraft = (value: string) => {
    session.draft = value;
    setDraftState(value);
  };
  const inputId = useId();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const last = turns[turns.length - 1];
  const running = last?.status === 'searching' || last?.status === 'answering';
  const lastAnswer = last?.answer.length ?? 0;

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns.length, lastAnswer]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (running || !draft.trim()) return;
    const question = draft;
    setDraft('');
    setShowChats(false);
    void session.ask(question);
  };
  const newChat = () => {
    session.clear();
    resetAskProposals(session);
    setShowChats(false);
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  const panel = (
    <aside className="db-ai-review-panel db-ai-ask-panel" aria-label="Ask">
      <div className="db-ai-review-header">
        <div>
          <h2>Ask</h2>
        </div>
        {chats && (
          <button
            type="button"
            className={`db-ai-ask-chats-toggle${chatList === 'beside' ? ' db-ai-ask-chats-toggle--narrow' : ''}`}
            aria-expanded={showChats}
            onClick={() => setShowChats((shown) => !shown)}
          >
            <ChatsIcon />
            Chats
          </button>
        )}
        {turns.length > 0 && (
          <button type="button" className="db-ai-ask-new" onClick={newChat}>
            New chat
          </button>
        )}
        <button
          type="button"
          className="db-close-button db-ai-review-close"
          onClick={onClose}
          aria-label="Close Ask"
        >
          <CloseIcon />
        </button>
      </div>

      {chats && showChats && (
        <div className="db-ai-ask-chats-overlay">
          <AskChatList
            chats={chats}
            activePath={chat?.workspaceId === chats.workspaceId ? chat.path : null}
            onNew={newChat}
            onPicked={() => setShowChats(false)}
          />
        </div>
      )}

      {notice && <NoticeBlock notice={notice} />}

      <div className="db-ai-ask-turns" aria-label="Conversation" hidden={chats && showChats}>
        {turns.length === 0 && (
          <div className="db-ai-ask-empty">
            <p>
              Chat with your AI. When your notes help, answers cite them; select a number to open
              that note.
            </p>
            {coverage && !notice && <p>{coverage}</p>}
          </div>
        )}
        {turns.map((turn) => (
          <section key={turn.id} className="db-ai-ask-turn" aria-label={turn.question}>
            <p className="db-ai-ask-question">{turn.question}</p>
            {turn.status === 'searching' && (
              <p className="db-ai-progress" role="status">
                <span className="db-ai-spinner" aria-hidden="true" />
                Searching your notes…
              </p>
            )}
            {turn.status === 'answering' && !turn.answer && generation && (
              <AiGenerationStatus state={generation} characters={0} />
            )}
            {turn.answer && <Answer turn={turn} onOpenNote={onOpenNote} />}
            {turn.status === 'stopped' && (
              <p className="db-ai-note" role="status">
                Stopped.
              </p>
            )}
            {turn.status === 'error' && (
              <p className="db-ai-error" role="alert">
                {turn.error ?? 'The question could not be answered.'}
              </p>
            )}
            {turn.truncated && (
              <p className="db-ai-note">The answer reached the model's length limit.</p>
            )}
            {/* Only sources that were used: a chat turn with none needs no pill. */}
            {turn.knowledge?.outcome === 'used' && (
              <AiKnowledgeIndicator
                knowledge={turn.knowledge}
                onOpenNote={(reference) => {
                  const evidence =
                    turn.knowledge?.outcome === 'used' ? turn.knowledge.evidence : [];
                  const passage = evidence.find(
                    (entry) =>
                      entry.uri !== undefined &&
                      parseWorkspacePassageUri(entry.uri)?.path === reference.path,
                  );
                  onOpenNote(reference, passage?.text ?? '');
                }}
              />
            )}
            {turn.status === 'done' && <AiFactsIndicator check={turn.facts} />}
            {turn.status === 'done' && turn.answer && (
              <TurnActions turn={turn} onSaveNote={onSaveNote} />
            )}
            {turn.status === 'done' && turn.answer && actions && (
              <TurnProposalsBlock
                turn={turn}
                session={session}
                ai={ai}
                facts={facts}
                actions={actions}
              />
            )}
          </section>
        ))}
        <div ref={endRef} />
      </div>

      {actions && !notice && <AllowEditsToggle session={session} />}
      <form className="db-ai-ask-form" onSubmit={submit}>
        <label htmlFor={inputId} className="db-visually-hidden">
          Message
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          rows={2}
          value={draft}
          maxLength={ASK_QUESTION_CHARACTERS}
          placeholder="Ask anything, or about your notes…"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <div className="db-ai-ask-running">
            <span className="db-ai-ask-chip" role="status">
              <span className="db-ai-spinner" aria-hidden="true" />
              {last?.status === 'searching' ? 'Searching…' : 'Answering…'}
            </span>
            <button type="button" onClick={() => session.stop()}>
              Stop
            </button>
          </div>
        ) : (
          <button type="submit" disabled={!draft.trim()}>
            Ask
          </button>
        )}
      </form>
    </aside>
  );
  return inEditor ? <EditorAnswerInsert>{panel}</EditorAnswerInsert> : panel;
}
