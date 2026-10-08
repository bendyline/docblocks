import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  useEditorContext,
  useEditorContextMenuItems,
  type EditorContextMenuItem,
  type EditorSelectionInfo,
} from '@bendyline/squisq-editor-react';
import type { AiChatEvent, AiChatHandle, DocBlocksHostAiAPI } from '@bendyline/docblocks/host';

import { Dialog } from '../components/Dialog.js';
import { useMenuKeyboard } from '../components/useMenuKeyboard.js';
import { unavailableSentence, useAiStatus } from './ai-status.js';
import { AiDiagramDialog } from './AiDiagrams.js';
import {
  AI_INSTRUCTION_CHARACTERS,
  AI_REVIEW_DOCUMENT_CHARACTERS,
  AI_REWRITE_SELECTION_CHARACTERS,
  applyAiReviewFinding,
  buildDraftRequest,
  buildReviewRequest,
  findUniqueExcerpt,
  parseAiReviewResponse,
  sanitizeGeneratedMarkdown,
  type AiDraftMode,
  type AiReviewFinding,
} from './ai-assistant.js';

/** The AI side panels; at most one is open at a time. */
export type AiPanel = 'review' | 'illustrate';

export interface AiToolbarControlProps {
  ai: DocBlocksHostAiAPI;
  readOnly?: boolean;
  openPanel: AiPanel | null;
  onOpenPanel: (panel: AiPanel) => void;
}

export interface AiReviewPanelProps {
  ai: DocBlocksHostAiAPI;
  onClose: () => void;
}

export function AiToolbarControl({
  ai,
  readOnly = false,
  openPanel,
  onOpenPanel,
}: AiToolbarControlProps) {
  const {
    activeView,
    editorMode,
    getSelection,
    insertBlockAfterCursor,
    layoutMode,
    markdownSource,
    replaceSelection,
    selectionVersion,
  } = useEditorContext();
  const status = useAiStatus(ai);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<AiDraftMode | null>(null);
  const [capturedSelection, setCapturedSelection] = useState<EditorSelectionInfo | null>(null);
  const [diagramSelection, setDiagramSelection] = useState<EditorSelectionInfo | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { menuRef, triggerRef, handleMenuKeyDown, handleTriggerKeyDown, closeMenu } =
    useMenuKeyboard(menuOpen, setMenuOpen);

  // The view and counter are reactive invalidators for this imperative snapshot.
  void activeView;
  void selectionVersion;
  const selection = getSelection();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const ready = status?.kind === 'ready' && status.model !== null;
  const openDiagram = () => {
    const current = getSelection();
    if (!current) return;
    setDiagramSelection(current);
    closeMenu(false);
  };
  // Registered before any early return: hooks must run on every render.
  const contextMenuItems: EditorContextMenuItem[] =
    editorMode === 'markdown' && ready && !readOnly
      ? [
          {
            id: 'docblocks-ai-diagram',
            label: 'Diagram this…',
            group: 'ai',
            when: 'selection',
            disabled: (context) => !context.editable,
            onSelect: openDiagram,
          },
        ]
      : [];
  useEditorContextMenuItems(contextMenuItems);

  if (
    editorMode !== 'markdown' ||
    (status?.kind === 'unavailable' && status.reason === 'opt-out')
  ) {
    return null;
  }

  const editableSelection = !readOnly && ready ? selection : null;
  const canCompose = editableSelection?.empty === true;
  const canRewrite =
    editableSelection?.empty === false &&
    editableSelection.text.length <= AI_REWRITE_SELECTION_CHARACTERS;

  const openDraft = (mode: AiDraftMode) => {
    const current = getSelection();
    if (!current) return;
    setCapturedSelection(current);
    setDraftMode(mode);
    closeMenu(false);
  };

  const closeDraft = () => {
    setDraftMode(null);
    setCapturedSelection(null);
  };

  return (
    <>
      <div className="db-toolbar-menu db-ai-toolbar" ref={rootRef}>
        <button
          ref={triggerRef}
          type="button"
          className={`squisq-toolbar-button db-ai-toolbar-trigger${openPanel ? ' squisq-toolbar-button--active' : ''}`}
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={handleTriggerKeyDown}
          aria-label="AI actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-tooltip="AI actions"
        >
          <SparklesGlyph />
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            className="db-toolbar-menu-dropdown db-ai-toolbar-menu"
            role="menu"
            aria-label="AI actions"
            onKeyDown={handleMenuKeyDown}
          >
            {!ready && (
              <div className="db-ai-toolbar-status" role="status">
                {unavailableSentence(status)}
              </div>
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-toolbar-menu-item"
              disabled={!canCompose}
              onClick={() => openDraft('compose')}
            >
              Add content…
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-toolbar-menu-item"
              disabled={!canRewrite}
              onClick={() => openDraft('rewrite')}
            >
              Rewrite selection…
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-toolbar-menu-item"
              disabled={!ready || readOnly}
              onClick={() => {
                closeMenu(false);
                onOpenPanel('review');
              }}
            >
              {openPanel === 'review' ? 'Show document review' : 'Review document…'}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-toolbar-menu-item"
              disabled={!ready || readOnly || layoutMode !== 'document'}
              onClick={() => {
                closeMenu(false);
                onOpenPanel('illustrate');
              }}
            >
              {openPanel === 'illustrate' ? 'Show illustrations' : 'Illustrate document…'}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-toolbar-menu-item"
              disabled={!editableSelection}
              onClick={openDiagram}
            >
              Insert diagram…
            </button>
            {ready && !selection && (
              <div className="db-ai-toolbar-status">Switch to Write or Source to edit with AI.</div>
            )}
            {ready && selection && !selection.empty && !canRewrite && (
              <div className="db-ai-toolbar-status">The selection is too long to rewrite.</div>
            )}
            {ready && layoutMode !== 'document' && (
              <div className="db-ai-toolbar-status">
                Switch to the Document layout to illustrate.
              </div>
            )}
          </div>
        )}
      </div>

      {draftMode && capturedSelection && (
        <AiDraftDialog
          ai={ai}
          mode={draftMode}
          documentSource={markdownSource}
          capturedSelection={capturedSelection}
          getSelection={getSelection}
          replaceSelection={replaceSelection}
          onClose={closeDraft}
        />
      )}
      {diagramSelection && (
        <AiDiagramDialog
          ai={ai}
          documentSource={markdownSource}
          capturedSelection={diagramSelection}
          getSelection={getSelection}
          insertBlockAfterCursor={insertBlockAfterCursor}
          onClose={() => setDiagramSelection(null)}
        />
      )}
    </>
  );
}

interface AiDraftDialogProps {
  ai: DocBlocksHostAiAPI;
  mode: AiDraftMode;
  documentSource: string;
  capturedSelection: EditorSelectionInfo;
  getSelection: () => EditorSelectionInfo | null;
  replaceSelection: (markdown: string) => boolean;
  onClose: () => void;
}

function AiDraftDialog({
  ai,
  mode,
  documentSource,
  capturedSelection,
  getSelection,
  replaceSelection,
  onClose,
}: AiDraftDialogProps) {
  const [instructions, setInstructions] = useState(
    mode === 'compose' ? '' : 'Improve clarity and flow while preserving the meaning and voice.',
  );
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finishNote, setFinishNote] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const handleRef = useRef<AiChatHandle | null>(null);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
      handleRef.current?.cancel();
    },
    [],
  );

  const generate = useCallback(() => {
    const prompt = instructions.trim();
    if (!prompt) {
      setError('Describe what you want the AI to write.');
      promptRef.current?.focus();
      return;
    }
    handleRef.current?.cancel();
    const requestId = ++requestRef.current;
    setDraft('');
    setError(null);
    setFinishNote(null);
    setRunning(true);
    const handle = ai.chat(
      buildDraftRequest({
        mode,
        instructions: prompt,
        documentSource,
        selectedText: capturedSelection.text,
      }),
      (event: AiChatEvent) => {
        if (requestRef.current !== requestId) return;
        if (event.kind === 'delta') {
          setDraft((current) => current + event.text);
          return;
        }
        setRunning(false);
        if (event.kind === 'error') {
          setError(event.error.message);
          return;
        }
        setDraft(sanitizeGeneratedMarkdown(event.completion.text));
        if (event.completion.finishReason === 'cancelled') setFinishNote('Generation stopped.');
        if (event.completion.finishReason === 'length') {
          setFinishNote('The model reached its output limit; review the ending before inserting.');
        }
      },
    );
    handleRef.current = handle;
  }, [ai, capturedSelection.text, documentSource, instructions, mode]);

  const stop = useCallback(() => handleRef.current?.cancel(), []);

  const apply = useCallback(() => {
    const replacement = sanitizeGeneratedMarkdown(draft);
    if (!replacement) return;
    const current = getSelection();
    if (!current || current.view !== capturedSelection.view) {
      setError('Return to the original editor view and try again.');
      return;
    }
    if (mode === 'compose' && !current.empty) {
      setError('The cursor selection changed. Close this dialog and choose Add content again.');
      return;
    }
    if (mode === 'rewrite' && (current.empty || current.text !== capturedSelection.text)) {
      setError('The selected text changed. Close this dialog and select it again.');
      return;
    }
    if (!replaceSelection(replacement)) {
      setError('DocBlocks could not apply the draft in the current editor view.');
      return;
    }
    onClose();
  }, [capturedSelection, draft, getSelection, mode, onClose, replaceSelection]);

  const dialog = (
    <Dialog
      title={mode === 'compose' ? 'Add content with AI' : 'Rewrite with AI'}
      onClose={onClose}
      size="wide"
      closeOnBackdrop={!running}
      initialFocusRef={promptRef as RefObject<HTMLElement | null>}
      className="db-ai-draft-dialog"
      footer={
        <>
          {/* In the footer, not the scrolling body: a long selection must never
              push progress or an error out of sight of the buttons. */}
          {(running || finishNote || error) && (
            <div className="db-ai-footer-status">
              {running && (
                <p className="db-ai-progress" role="status">
                  <span className="db-ai-spinner" aria-hidden="true" /> Writing…
                </p>
              )}
              {finishNote && <p className="db-ai-note">{finishNote}</p>}
              {error && (
                <p className="db-ai-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {running ? (
            <button type="button" className="db-ai-secondary-action" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="db-ai-secondary-action" onClick={generate}>
              {draft ? 'Regenerate' : 'Generate'}
            </button>
          )}
          <button type="button" disabled={!draft.trim() || running} onClick={apply}>
            {mode === 'compose' ? 'Insert' : 'Replace selection'}
          </button>
        </>
      }
    >
      <label className="db-ai-field">
        <span>
          {mode === 'compose' ? 'What should be added?' : 'How should this be rewritten?'}
        </span>
        <textarea
          ref={promptRef}
          value={instructions}
          maxLength={AI_INSTRUCTION_CHARACTERS}
          rows={3}
          placeholder={
            mode === 'compose'
              ? 'For example: Add a concise introduction for this document.'
              : 'For example: Make this shorter and more direct.'
          }
          onChange={(event) => setInstructions(event.currentTarget.value)}
        />
      </label>

      {mode === 'rewrite' && (
        <div className="db-ai-selection-preview">
          <span>Selected text</span>
          {/* Focusable so keyboard users can scroll a long selection. */}
          <blockquote tabIndex={0} aria-label="Selected text">
            {capturedSelection.text}
          </blockquote>
        </div>
      )}

      <label className="db-ai-field">
        <span>AI draft</span>
        <textarea
          className="db-ai-draft-output"
          value={draft}
          rows={10}
          placeholder={running ? 'Writing…' : 'The generated Markdown will appear here.'}
          aria-busy={running}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </label>
      <p className="db-ai-disclaimer">Review AI-generated content before adding it.</p>
    </Dialog>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

type ReviewPhase = 'idle' | 'running' | 'ready' | 'error';

export function AiReviewPanel({ ai, onClose }: AiReviewPanelProps) {
  const { markdownSource, replaceAll } = useEditorContext();
  const [phase, setPhase] = useState<ReviewPhase>('idle');
  const [findings, setFindings] = useState<readonly AiReviewFinding[]>([]);
  const [reviewedSource, setReviewedSource] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [applyErrorId, setApplyErrorId] = useState<string | null>(null);
  const handleRef = useRef<AiChatHandle | null>(null);
  const requestRef = useRef(0);
  const startedRef = useRef(false);

  const cancelReview = useCallback(() => {
    requestRef.current += 1;
    handleRef.current?.cancel();
    handleRef.current = null;
    setPhase('idle');
  }, []);

  const runReview = useCallback(() => {
    if (!markdownSource.trim()) {
      setFindings([]);
      setReviewedSource(markdownSource);
      setResolvedIds(new Set());
      setError(null);
      setPhase('ready');
      return;
    }
    if (markdownSource.length > AI_REVIEW_DOCUMENT_CHARACTERS) {
      setError('This document is too long for one AI review pass. Review a shorter document.');
      setPhase('error');
      return;
    }

    handleRef.current?.cancel();
    const requestId = ++requestRef.current;
    const source = markdownSource;
    setPhase('running');
    setFindings([]);
    setResolvedIds(new Set());
    setApplyErrorId(null);
    setError(null);
    const handle = ai.chat(buildReviewRequest(source), (event: AiChatEvent) => {
      if (requestRef.current !== requestId || event.kind === 'delta') return;
      handleRef.current = null;
      if (event.kind === 'error') {
        setError(event.error.message);
        setPhase('error');
        return;
      }
      const parsed = parseAiReviewResponse(event.completion.text);
      if (!parsed) {
        setError('The AI returned a review DocBlocks could not read. Try reviewing again.');
        setPhase('error');
        return;
      }
      setFindings(parsed);
      setReviewedSource(source);
      setPhase('ready');
    });
    handleRef.current = handle;
  }, [ai, markdownSource]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runReview();
  }, [runReview]);

  useEffect(
    () => () => {
      requestRef.current += 1;
      handleRef.current?.cancel();
      handleRef.current = null;
      // StrictMode replays mount effects in development. The cancelled pass
      // must allow that next setup to start a live review.
      startedRef.current = false;
    },
    [],
  );

  const applyFinding = useCallback(
    (finding: AiReviewFinding) => {
      const next = applyAiReviewFinding(markdownSource, finding);
      if (next === null) {
        setApplyErrorId(finding.id);
        return;
      }
      replaceAll(next);
      setReviewedSource(next);
      setApplyErrorId(null);
      setResolvedIds((current) => new Set([...current, finding.id]));
    },
    [markdownSource, replaceAll],
  );

  const dismissFinding = useCallback((id: string) => {
    setApplyErrorId((current) => (current === id ? null : current));
    setResolvedIds((current) => new Set([...current, id]));
  }, []);

  const visibleFindings = findings.filter((finding) => !resolvedIds.has(finding.id));
  const documentChanged = reviewedSource !== null && markdownSource !== reviewedSource;

  return (
    <aside className="db-ai-review-panel" aria-label="AI document review">
      <div className="db-ai-review-header">
        <div>
          <h2>AI review</h2>
          {phase === 'ready' && (
            <span className="db-ai-review-count">
              {visibleFindings.length} {visibleFindings.length === 1 ? 'finding' : 'findings'}
            </span>
          )}
        </div>
        <button
          type="button"
          className="db-ai-review-close"
          onClick={onClose}
          aria-label="Close AI review"
        >
          ×
        </button>
      </div>

      <div className="db-ai-review-actions">
        {phase === 'running' ? (
          <button type="button" onClick={cancelReview}>
            Stop review
          </button>
        ) : (
          <button type="button" onClick={runReview}>
            {phase === 'idle' ? 'Review document' : 'Review again'}
          </button>
        )}
      </div>

      {phase === 'running' && (
        <div className="db-ai-review-empty" role="status">
          <span className="db-ai-spinner" aria-hidden="true" /> Reviewing this document…
        </div>
      )}
      {phase === 'error' && error && (
        <div className="db-ai-review-empty db-ai-error" role="alert">
          {error}
        </div>
      )}
      {documentChanged && phase === 'ready' && (
        <div className="db-ai-review-stale" role="status">
          The document changed after this review. Suggestions are applied only when their original
          text still matches exactly.
        </div>
      )}
      {phase === 'ready' && visibleFindings.length === 0 && (
        <div className="db-ai-review-empty">
          {findings.length === 0 ? 'Nothing to report.' : 'All findings have been handled.'}
        </div>
      )}

      <ol className="db-ai-review-list">
        {visibleFindings.map((finding) => {
          const canApply =
            finding.replacement !== null &&
            findUniqueExcerpt(markdownSource, finding.originalText) !== null;
          return (
            <li key={finding.id} className="db-ai-review-finding">
              <div className="db-ai-review-finding-meta">
                <span
                  className={`db-ai-review-severity db-ai-review-severity--${finding.severity}`}
                >
                  {finding.severity}
                </span>
                <span>{finding.category}</span>
              </div>
              <h3>{finding.message}</h3>
              {finding.rationale && <p>{finding.rationale}</p>}
              <div className="db-ai-review-excerpt">
                <span>Current text</span>
                <blockquote>{finding.originalText}</blockquote>
              </div>
              {finding.replacement !== null && (
                <div className="db-ai-review-excerpt db-ai-review-excerpt--replacement">
                  <span>Suggested</span>
                  <blockquote>{finding.replacement}</blockquote>
                </div>
              )}
              {applyErrorId === finding.id && (
                <p className="db-ai-error" role="alert">
                  This text no longer has one exact match. Review the document again before applying
                  it.
                </p>
              )}
              <div className="db-ai-review-finding-actions">
                <button type="button" onClick={() => dismissFinding(finding.id)}>
                  Dismiss
                </button>
                {finding.replacement !== null && (
                  <button
                    type="button"
                    disabled={!canApply}
                    title={canApply ? undefined : 'The reviewed text no longer has one exact match'}
                    onClick={() => applyFinding(finding)}
                  >
                    Apply
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="db-ai-review-disclaimer">AI suggestions can be wrong. Review each change.</p>
    </aside>
  );
}

function SparklesGlyph() {
  return (
    <svg
      viewBox="0 0 18 18"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.2 2.2c.45 2.2 1.75 3.5 3.95 3.95-2.2.45-3.5 1.75-3.95 3.95-.45-2.2-1.75-3.5-3.95-3.95C5.45 5.7 6.75 4.4 7.2 2.2Z" />
      <path d="M13.1 9.2c.3 1.45 1.15 2.3 2.6 2.6-1.45.3-2.3 1.15-2.6 2.6-.3-1.45-1.15-2.3-2.6-2.6 1.45-.3 2.3-1.15 2.6-2.6Z" />
    </svg>
  );
}
