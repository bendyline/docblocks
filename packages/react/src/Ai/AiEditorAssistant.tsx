import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  useEditorContext,
  useEditorContextMenuItems,
  type EditorContextMenuItem,
  type EditorSelectionInfo,
} from '@bendyline/squisq-editor-react';
import type {
  AiChatEvent,
  AiChatHandle,
  AiChatRequest,
  AiModelInfo,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { Dialog } from '../components/Dialog.js';
import { useConfirmDialog } from '../components/useConfirmDialog.js';
import { useMenuKeyboard } from '../components/useMenuKeyboard.js';
import { unavailableSentence, useAiStatus } from './ai-status.js';
import { AiDiagramDialog } from './AiDiagrams.js';
import { AiGenerationStatus, type AiGenerationState } from './AiGenerationStatus.js';
import { draftCapacityNotice } from './draft-capacity.js';
import {
  AI_INSTRUCTION_CHARACTERS,
  AI_REVIEW_DOCUMENT_CHARACTERS,
  AI_REWRITE_SELECTION_CHARACTERS,
  applyAiReviewFinding,
  buildDraftContinuation,
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
    (editableSelection.markdown ?? editableSelection.text).length <=
      AI_REWRITE_SELECTION_CHARACTERS;

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
          model={status?.kind === 'ready' ? status.model : null}
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
  model?: AiModelInfo | null;
  mode: AiDraftMode;
  documentSource: string;
  capturedSelection: EditorSelectionInfo;
  getSelection: () => EditorSelectionInfo | null;
  replaceSelection: (markdown: string) => boolean;
  onClose: () => void;
}

export function AiDraftDialog({
  ai,
  model,
  mode,
  documentSource,
  capturedSelection,
  getSelection,
  replaceSelection,
  onClose,
}: AiDraftDialogProps) {
  const defaultInstructions =
    mode === 'compose'
      ? 'Add a concise introduction for this document.'
      : 'Improve clarity and flow while preserving the meaning and voice.';
  const [instructions, setInstructions] = useState('');
  // null is the initial Generate affordance; an empty string is a draft the
  // model (or the user) cleared, which must remain editable and regenerable.
  const [draft, setDraft] = useState<string | null>(null);
  const generatedDraftRef = useRef('');
  const carriedEditsRef = useRef(false);
  const [originalRequest, setOriginalRequest] = useState<AiChatRequest | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [prefixCharacters, setPrefixCharacters] = useState(0);
  const [running, setRunning] = useState(false);
  const [generation, setGeneration] = useState<AiGenerationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finishNote, setFinishNote] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const handleRef = useRef<AiChatHandle | null>(null);
  const requestRef = useRef(0);
  const { confirm: confirmAction, confirmDialog } = useConfirmDialog();
  const selectedMarkdown = capturedSelection.markdown ?? capturedSelection.text;
  const draftRequest = useMemo(
    () => ({
      ...buildDraftRequest({
        mode,
        instructions: instructions.trim() || defaultInstructions,
        documentSource,
        selectedText: selectedMarkdown,
      }),
      ...(model ? { model: model.id } : {}),
    }),
    [mode, instructions, defaultInstructions, documentSource, selectedMarkdown, model],
  );
  const continuationRequest =
    originalRequest && draft
      ? buildDraftContinuation({ ...originalRequest, ...(model ? { model: model.id } : {}) }, draft)
      : null;
  const capacity = draftCapacityNotice(
    incomplete && continuationRequest ? continuationRequest : draftRequest,
    model,
    incomplete || mode === 'compose' ? '' : selectedMarkdown,
  );

  useEffect(
    () => () => {
      requestRef.current += 1;
      handleRef.current?.cancel();
    },
    [],
  );

  const start = useCallback(
    (request: AiChatRequest, prefix = '') => {
      const requestId = ++requestRef.current;
      handleRef.current?.cancel();
      generatedDraftRef.current = prefix;
      setDraft(prefix);
      setPrefixCharacters(prefix.length);
      setError(null);
      setFinishNote(null);
      setIncomplete(false);
      setRunning(true);
      const startedAt = Date.now();
      setGeneration({ progress: null, startedAt, lastActivityAt: startedAt });
      const handle = ai.chat(request, (event: AiChatEvent) => {
        if (requestRef.current !== requestId) return;
        if (event.kind === 'progress') {
          setGeneration(
            (current) =>
              current && {
                ...current,
                progress: event.progress,
                lastActivityAt: Date.now(),
              },
          );
          return;
        }
        if (event.kind === 'delta') {
          generatedDraftRef.current += event.text;
          setDraft(generatedDraftRef.current);
          setGeneration(
            (current) =>
              current && {
                ...current,
                lastActivityAt: Date.now(),
                progress: {
                  phase: 'generating',
                  percent: null,
                  outputTokens: current.progress?.outputTokens ?? null,
                  tokensPerSecond: current.progress?.tokensPerSecond ?? null,
                },
              },
          );
          return;
        }
        setRunning(false);
        if (event.kind === 'error') {
          setError(event.error.message);
          setIncomplete(Boolean(generatedDraftRef.current.trim()));
          return;
        }
        const emptyContinuation = Boolean(prefix) && !event.completion.text.trim();
        const finished = event.completion.finishReason === 'stop' && !emptyContinuation;
        // Keep whitespace at the join: the preceding response may end mid-word
        // or mid-table. Never trim a continuation independently of its draft.
        generatedDraftRef.current =
          prefix || !finished
            ? prefix + event.completion.text
            : sanitizeGeneratedMarkdown(event.completion.text);
        setDraft(generatedDraftRef.current);
        setIncomplete(!finished && Boolean(generatedDraftRef.current.trim()));
        if (event.completion.finishReason === 'cancelled') {
          setFinishNote('Generation stopped. The draft may be incomplete.');
        }
        if (event.completion.finishReason === 'length') {
          setFinishNote(
            generatedDraftRef.current.trim()
              ? 'Draft incomplete: the model reached a limit. Continue the draft to request the rest. If this repeats, use a smaller selection or a model with more context. Your draft and original document are preserved.'
              : 'The model reached a limit before producing a draft. Try a smaller selection or a model with more context. Your original document is unchanged.',
          );
        }
        if (emptyContinuation && event.completion.finishReason === 'stop') {
          setFinishNote(
            'The model returned no additional text. Your draft is preserved and may still be incomplete. Try a smaller selection or a model with more context.',
          );
        }
      });
      handleRef.current = handle;
    },
    [ai],
  );

  const generate = useCallback(async () => {
    if (running || draftCapacityNotice(draftRequest, model)?.blocked) return;
    const previousRequest = requestRef.current;
    if (draft !== null && (carriedEditsRef.current || draft !== generatedDraftRef.current)) {
      const accepted = await confirmAction({
        title: 'Regenerate AI draft',
        message: 'This will remove all edits you have made. Continue?',
        confirmLabel: 'Continue',
        destructive: true,
      });
      if (!accepted || requestRef.current !== previousRequest) return;
    }
    carriedEditsRef.current = false;
    setOriginalRequest(draftRequest);
    start(draftRequest);
  }, [running, draftRequest, model, draft, confirmAction, start]);

  const continueDraft = () => {
    if (running || !incomplete || !draft || !continuationRequest || capacity?.blocked) return;
    carriedEditsRef.current ||= draft !== generatedDraftRef.current;
    start(continuationRequest, draft);
  };

  const stop = useCallback(() => handleRef.current?.cancel(), []);

  const apply = useCallback(async () => {
    if (running) return;
    const replacement = sanitizeGeneratedMarkdown(draft ?? '');
    if (!replacement) return;
    if (incomplete) {
      const previousRequest = requestRef.current;
      const accepted = await confirmAction({
        title: 'Use incomplete AI draft?',
        message:
          mode === 'rewrite'
            ? 'This draft did not finish. Replacing the selection may remove content that has not been rewritten. Use it only if you have reviewed and completed it yourself.'
            : 'This draft did not finish. Use it only if you have reviewed and completed it yourself.',
        confirmLabel: mode === 'rewrite' ? 'Replace anyway' : 'Insert anyway',
        destructive: mode === 'rewrite',
      });
      if (!accepted || requestRef.current !== previousRequest) return;
    }
    const current = getSelection();
    if (!current || current.view !== capturedSelection.view) {
      setError('Return to the original editor view and try again.');
      return;
    }
    if (mode === 'compose' && !current.empty) {
      setError('The cursor selection changed. Close this dialog and choose Add content again.');
      return;
    }
    if (
      mode === 'rewrite' &&
      (current.empty ||
        current.text !== capturedSelection.text ||
        (current.markdown ?? current.text) !== selectedMarkdown)
    ) {
      setError('The selected text changed. Close this dialog and select it again.');
      return;
    }
    if (!replaceSelection(replacement)) {
      setError('DocBlocks could not apply the draft in the current editor view.');
      return;
    }
    onClose();
  }, [
    capturedSelection,
    selectedMarkdown,
    draft,
    getSelection,
    mode,
    onClose,
    replaceSelection,
    running,
    incomplete,
    confirmAction,
  ]);

  const dialog = (
    <Dialog
      title={mode === 'compose' ? 'Add content with AI' : 'Rewrite with AI'}
      onClose={onClose}
      size="wide"
      closeOnBackdrop={!running}
      initialFocusRef={promptRef as RefObject<HTMLElement | null>}
      className="db-ai-draft-dialog"
      bodyClassName="db-ai-draft-body"
      footerClassName="db-ai-draft-footer"
      footer={
        <>
          {/* In the footer, not the scrolling body: a long selection must never
              push progress or an error out of sight of the buttons. */}
          {(running || finishNote || error || capacity) && (
            <div className="db-ai-footer-status">
              {running && generation && (
                <AiGenerationStatus
                  state={generation}
                  characters={Math.max(0, (draft?.length ?? 0) - prefixCharacters)}
                />
              )}
              {finishNote && <p className="db-ai-note">{finishNote}</p>}
              {!running && capacity && (
                <p className="db-ai-note" role="status">
                  {capacity.message}
                </p>
              )}
              {error && (
                <p className="db-ai-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
          <div className="db-ai-draft-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            {running ? (
              <button type="button" className="db-ai-secondary-action" onClick={stop}>
                Stop
              </button>
            ) : draft !== null ? (
              <>
                <button type="button" className="db-ai-secondary-action" onClick={generate}>
                  Regenerate
                </button>
                {incomplete && draft.trim() && (
                  <button type="button" disabled={capacity?.blocked} onClick={continueDraft}>
                    Continue draft
                  </button>
                )}
              </>
            ) : null}
            <button type="button" disabled={!draft?.trim() || running} onClick={apply}>
              {mode === 'compose' ? 'Insert' : 'Replace selection'}
            </button>
          </div>
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
          rows={2}
          placeholder={defaultInstructions}
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

      {draft === null ? (
        <div className="db-ai-draft-start">
          <button type="button" onClick={generate} disabled={capacity?.blocked}>
            {capacity && !capacity.blocked ? 'Generate anyway' : 'Generate'}
          </button>
        </div>
      ) : (
        <>
          <label className="db-ai-field db-ai-draft-field">
            <span>AI draft</span>
            <textarea
              className="db-ai-draft-output"
              value={draft}
              rows={10}
              placeholder={running ? 'The draft will appear here.' : ''}
              aria-busy={running}
              readOnly={running}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <p className="db-ai-disclaimer">Review and edit AI-generated content before adding it.</p>
        </>
      )}
    </Dialog>
  );

  const dialogs = (
    <>
      {dialog}
      {confirmDialog}
    </>
  );
  return typeof document === 'undefined' ? dialogs : createPortal(dialogs, document.body);
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
      if (requestRef.current !== requestId || event.kind === 'delta' || event.kind === 'progress')
        return;
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
