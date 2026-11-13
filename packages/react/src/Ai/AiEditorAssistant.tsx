import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  useEditorContext,
  useEditorContextMenuItems,
  useEditorInsertMenuItems,
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
import { CloseIcon } from '../icons.js';
import { useConfirmDialog } from '../components/useConfirmDialog.js';
import { useMenuKeyboard } from '../components/useMenuKeyboard.js';
import { unavailableSentence, useAiStatus } from './ai-status.js';
import { AiDiagramDialog } from './AiDiagrams.js';
import { AiGenerationStatus, type AiGenerationState } from './AiGenerationStatus.js';
import { AiFactsIndicator, AiKnowledgeIndicator } from './AiKnowledgeIndicator.js';
import { factCheckRequest, factsNeedReview, useAiKnowledge, useFactCheck } from './ai-knowledge.js';
import { citationsToFootnotes, stripCitationMarkers } from './knowledge-citations.js';
import { AiReportButton } from './AiOutputReport.js';
import { draftCapacityNotice } from './draft-capacity.js';
import {
  AI_INSTRUCTION_CHARACTERS,
  AI_REWRITE_SELECTION_CHARACTERS,
  applyAiReviewFinding,
  buildDraftContinuation,
  buildDraftRequest,
  findUniqueExcerpt,
  type AiDraftMode,
  type AiReviewFinding,
} from './ai-assistant.js';
import { draftToApply, settleDraft } from './draft-run.js';
import { locateReviewExcerpt, type ExcerptLocation } from './review-locate.js';
import { canReveal, revealSourceRange } from './review-reveal.js';
import {
  numberReviewFindings,
  readReviewReply,
  reviewStepRequest,
  startReviewRun,
  type ReviewRun,
} from './review-run.js';
import {
  AI_REVIEW_STYLE_DEFINITIONS,
  AI_REVIEW_STYLES,
  isAiReviewStyle,
  type AiReviewStyle,
} from './review-styles.js';
import { STUDY_AID_KINDS, STUDY_AID_LABELS, type StudyAidKind } from './study-aids.js';

// The study viewers and pipeline load only when one of their dialogs opens.
const AiStudyDialog = lazy(() =>
  import('./AiStudyDialog.js').then((module) => ({ default: module.AiStudyDialog })),
);

/** The AI side panels; at most one is open at a time. */
export type AiPanel = 'review' | 'illustrate' | 'images';

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
    fileName,
    getSelection,
    insertBlockAfterCursor,
    layoutMode,
    markdownSource,
    replaceSelection,
    selectionVersion,
    workspaceContainer,
  } = useEditorContext();
  const status = useAiStatus(ai);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<AiDraftMode | null>(null);
  const [capturedSelection, setCapturedSelection] = useState<EditorSelectionInfo | null>(null);
  const [diagramSelection, setDiagramSelection] = useState<EditorSelectionInfo | null>(null);
  const [studyKind, setStudyKind] = useState<StudyAidKind | null>(null);
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

  // The shell builds a new sidecar container for each document. A study
  // dialog belongs to the document it opened on, so switching documents
  // closes it, which cancels a run before it could save into the wrong one.
  useEffect(() => setStudyKind(null), [workspaceContainer]);

  const ready = status?.kind === 'ready' && status.model !== null;
  // Images need the connection, not a chat model; the panel explains any
  // further step, such as allowing image generation in Gezel.
  const imagesOffered =
    ai.images !== undefined && status?.kind === 'ready' && !readOnly && editorMode === 'markdown';
  const openImages = () => {
    closeMenu(false);
    onOpenPanel('images');
  };
  useEditorInsertMenuItems(
    imagesOffered
      ? [
          {
            id: 'docblocks-ai-image',
            label: 'Image from a description…',
            icon: <SparklesGlyph />,
            onSelect: openImages,
          },
        ]
      : [],
  );
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
  if (imagesOffered) {
    contextMenuItems.push({
      id: 'docblocks-ai-image',
      label: 'Generate image from selection…',
      group: 'ai',
      when: 'selection',
      disabled: (context) => !context.editable,
      onSelect: openImages,
    });
  }
  useEditorContextMenuItems(contextMenuItems);

  if (
    editorMode !== 'markdown' ||
    (status?.kind === 'unavailable' && status.reason === 'opt-out')
  ) {
    return null;
  }

  const editableSelection = !readOnly && ready ? selection : null;
  // Study aids leave the document alone but save beside it, so they need
  // the sidecar and a writable document, not a selection.
  const canStudy =
    ready && !readOnly && workspaceContainer !== null && markdownSource.trim().length > 0;
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
            {ai.images && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="db-toolbar-menu-item"
                disabled={!imagesOffered}
                onClick={openImages}
              >
                {openPanel === 'images' ? 'Show image generation' : 'Generate image…'}
              </button>
            )}
            <div className="db-toolbar-menu-divider" role="separator" />
            {STUDY_AID_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="db-toolbar-menu-item"
                disabled={!canStudy}
                onClick={() => {
                  closeMenu(false);
                  setStudyKind(kind);
                }}
              >
                {STUDY_AID_LABELS[kind].menu}
              </button>
            ))}
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
      {studyKind && workspaceContainer && (
        <Suspense fallback={null}>
          <AiStudyDialog
            key={studyKind}
            ai={ai}
            kind={studyKind}
            documentSource={markdownSource}
            documentName={(fileName ?? '').split('/').pop() || 'Untitled.md'}
            container={workspaceContainer}
            onClose={() => setStudyKind(null)}
          />
        </Suspense>
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
  /** Ends the running request for the person, without waiting for the provider. */
  const stopRef = useRef<(() => void) | null>(null);
  const requestRef = useRef(0);
  const { confirm: confirmAction, confirmDialog } = useConfirmDialog();
  const { knowledge, citable, ai: knowledgeAi, reset: resetKnowledge } = useAiKnowledge(ai);
  const selectedMarkdown = capturedSelection.markdown ?? capturedSelection.text;
  // What the person supplied, as the model received it: instructions plus the
  // document or selection. A detail found here needs no other source.
  const factsGiven = useMemo(
    () =>
      originalRequest?.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n\n') ?? '',
    [originalRequest],
  );
  const facts = useFactCheck(ai, running ? null : draft, knowledge, factsGiven, citable);
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
      // A continuation finishes the same draft, so it adds to what the draft cited.
      if (!prefix) resetKnowledge();
      const startedAt = Date.now();
      setGeneration({ progress: null, startedAt, lastActivityAt: startedAt });
      // How the request ends in the dialog: the provider's last event, or Stop.
      const finish = (event: Extract<AiChatEvent, { kind: 'done' | 'error' }>) => {
        setRunning(false);
        // Nothing arrived: return to the prompt instead of an empty draft.
        const nothing =
          !prefix &&
          !generatedDraftRef.current.trim() &&
          (event.kind === 'error' || !event.completion.text.trim());
        if (nothing && (event.kind === 'error' || event.completion.finishReason === 'cancelled')) {
          generatedDraftRef.current = '';
          setDraft(null);
          if (event.kind === 'error') setError(event.error.message);
          return;
        }
        if (event.kind === 'error') {
          setError(event.error.message);
          setIncomplete(Boolean(generatedDraftRef.current.trim()));
          return;
        }
        // Shared with the headless draft (and so the docbench pack): whitespace
        // at a join is kept, a continuation is never cleaned up on its own, and
        // document text copied into new content is removed.
        const settled = settleDraft(prefix, event.completion, documentSource, mode);
        const { emptyContinuation, finished } = settled;
        generatedDraftRef.current = settled.draft;
        setDraft(generatedDraftRef.current);
        setIncomplete(!finished && Boolean(generatedDraftRef.current.trim()));
        if (settled.echoRemoved) {
          setFinishNote(
            settled.draft.trim()
              ? 'Removed text the model copied from your document.'
              : 'The model only repeated text already in your document. Regenerate, or make the instructions more specific.',
          );
        }
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
      };
      const handle = knowledgeAi.chat(request, (event: AiChatEvent) => {
        if (requestRef.current !== requestId || event.kind === 'knowledge') return;
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
        finish(event);
      });
      handleRef.current = handle;
      // Stop ends the request here and now. The provider is told, not waited
      // for: one that is still loading the model took 9.5 seconds to answer a
      // cancel, and until it did the dialog kept counting "Waiting for
      // model…" with Stop still showing. Its own ending is then a stale event.
      stopRef.current = () => {
        if (requestRef.current !== requestId) return;
        requestRef.current += 1;
        handle.cancel();
        finish({
          kind: 'done',
          completion: {
            text: generatedDraftRef.current.slice(prefix.length),
            model: request.model ?? '',
            finishReason: 'cancelled',
            usage: null,
          },
        });
      };
    },
    [knowledgeAi, resetKnowledge, documentSource, mode],
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

  const stop = useCallback(() => stopRef.current?.(), []);

  const apply = useCallback(async () => {
    if (running) return;
    const replacement = draftToApply(draft ?? '', documentSource);
    if (!replacement) return;
    // An unfinished draft is confirmed below as reviewed by the person, so it is not asked twice.
    const factCheck =
      !incomplete && ai.checkFacts && factCheckRequest(replacement, knowledge, factsGiven, citable);
    if (factCheck) {
      // Checked afresh: the indicator may still be waiting out an edit.
      const previousRequest = requestRef.current;
      const checked = await ai.checkFacts?.(factCheck);
      if (requestRef.current !== previousRequest) return;
      if (checked?.ok && factsNeedReview(checked.value)) {
        const count = checked.value.unsourced.length;
        const accepted = await confirmAction({
          title: 'Use details no source shows?',
          message:
            `${count} ${count === 1 ? 'statement in this draft includes' : 'statements in this draft include'} ` +
            'names, dates or numbers that neither your document nor the reference passages show. ' +
            'The model may have written them from memory. Check them before you rely on them.',
          confirmLabel: mode === 'rewrite' ? 'Replace anyway' : 'Insert anyway',
          cancelLabel: 'Review draft',
        });
        if (!accepted || requestRef.current !== previousRequest) return;
      }
    }
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
    // `[n]` points into this dialog's passages. New content keeps it as a
    // footnote naming the source; a rewritten selection drops it, since its
    // paragraph has nowhere to put the note.
    const inserted =
      knowledge?.outcome !== 'used'
        ? replacement
        : mode === 'compose' && citable
          ? citationsToFootnotes(
              replacement,
              knowledge.evidence,
              new Map(knowledge.sources.map((source) => [source.catalogId, source.name])),
              documentSource,
            )
          : stripCitationMarkers(replacement);
    if (!replaceSelection(inserted)) {
      setError('DocBlocks could not apply the draft in the current editor view.');
      return;
    }
    onClose();
  }, [
    capturedSelection,
    selectedMarkdown,
    documentSource,
    draft,
    getSelection,
    mode,
    onClose,
    replaceSelection,
    running,
    incomplete,
    confirmAction,
    ai,
    knowledge,
    factsGiven,
    citable,
  ]);

  const dialog = (
    <Dialog
      title={mode === 'compose' ? 'Add content with AI' : 'Rewrite with AI'}
      onClose={onClose}
      size="wide"
      closeOnBackdrop={false}
      initialFocusRef={promptRef as RefObject<HTMLElement | null>}
      className="db-ai-draft-dialog"
      bodyClassName="db-ai-draft-body"
      footerClassName="db-ai-draft-footer"
      footer={
        <>
          {/* In the footer, not the scrolling body: a long selection must never
              push progress or an error out of sight of the buttons. */}
          {/* Boolean(): a check that found nothing to check has `checked: 0`, and
              React draws a bare 0. */}
          {(running || finishNote || error || capacity || knowledge || Boolean(facts?.checked)) && (
            <div className="db-ai-footer-status">
              {running && generation && (
                <AiGenerationStatus
                  state={generation}
                  characters={Math.max(0, (draft?.length ?? 0) - prefixCharacters)}
                />
              )}
              <AiKnowledgeIndicator knowledge={knowledge} />
              {!running && <AiFactsIndicator check={facts} />}
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
          <p className="db-ai-disclaimer">
            Review and edit AI-generated content before adding it.
            {!running && (
              <>
                {' '}
                <AiReportButton
                  feature={mode === 'compose' ? 'Add content' : 'Rewrite selection'}
                  getOutput={() => generatedDraftRef.current}
                  model={model?.label ?? null}
                />
              </>
            )}
          </p>
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

/** What the review is doing now, for the status line while it runs. */
function reviewingText(active: { part: number; more: boolean } | null, parts: number): string {
  const part = active?.part ?? 0;
  if (parts > 1) {
    return active?.more
      ? `Looking for more in part ${part + 1} of ${parts}…`
      : `Reviewing part ${part + 1} of ${parts}…`;
  }
  return active?.more ? 'Looking for more findings…' : 'Reviewing this document…';
}

/** "Part 3 was" or "Parts 2, 3 and 5 were", for zero-based `indexes`. */
function partsWere(indexes: readonly number[]): string {
  const numbers = indexes.map((index) => String(index + 1));
  const last = numbers.pop() ?? '';
  return numbers.length === 0 ? `Part ${last} was` : `Parts ${numbers.join(', ')} and ${last} were`;
}

/** The review as the reporter saw it: each finding and its suggested text. */
function formatReviewFindings(findings: readonly AiReviewFinding[]): string {
  return findings
    .map((finding) =>
      [
        `${finding.severity} · ${finding.category}: ${finding.message}`,
        finding.rationale,
        finding.replacement !== null ? `Suggested: ${finding.replacement}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

export function AiReviewPanel({ ai, onClose }: AiReviewPanelProps) {
  const {
    activeView,
    goToBlockByLine,
    layoutMode,
    markdownSource,
    monacoEditor,
    replaceAll,
    setActiveView,
    tiptapEditor,
  } = useEditorContext();
  /** The finding last shown in the document, and what to say about where it was found. */
  const [shown, setShown] = useState<{ id: string; note: string | null } | null>(null);
  /** A location to select once the view or block it needs is showing. */
  const [pendingReveal, setPendingReveal] = useState<{
    id: string;
    location: ExcerptLocation;
  } | null>(null);
  // No default: each review style asks for different changes, so the person
  // chooses one before the first review runs.
  const [style, setStyle] = useState<AiReviewStyle | null>(null);
  /** The style of the review on screen, which the list may since have moved off. */
  const [reviewedStyle, setReviewedStyle] = useState<AiReviewStyle | null>(null);
  const styleDescriptionId = useId();
  const [phase, setPhase] = useState<ReviewPhase>('idle');
  const [findings, setFindings] = useState<readonly AiReviewFinding[]>([]);
  const [reviewedSource, setReviewedSource] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  /** The reply stopped at the model's output limit, so findings may be missing. */
  const [cutOff, setCutOff] = useState(false);
  /** Findings the AI returned in a shape DocBlocks could not use, left out of the list. */
  const [dropped, setDropped] = useState(0);
  const [applyErrorId, setApplyErrorId] = useState<string | null>(null);
  const [reviewModel, setReviewModel] = useState<string | null>(null);
  const [run, setRun] = useState<ReviewRun | null>(null);
  /** Parts of `run` reviewed or skipped: the index of the next part to send. */
  const [partsDone, setPartsDone] = useState(0);
  const [skippedParts, setSkippedParts] = useState<readonly number[]>([]);
  /** The part being reviewed, and whether this is a follow-up asking it for more. */
  const [active, setActive] = useState<{ part: number; more: boolean } | null>(null);
  const handleRef = useRef<AiChatHandle | null>(null);
  const requestRef = useRef(0);
  const status = useAiStatus(ai);
  const contextWindow = status?.kind === 'ready' ? (status.model?.contextWindow ?? null) : null;
  const { knowledge, ai: knowledgeAi, reset: resetKnowledge } = useAiKnowledge(ai);

  // Stopping keeps the findings of every part that finished; a review
  // stopped before any part finished is no review at all.
  const cancelReview = useCallback(() => {
    requestRef.current += 1;
    handleRef.current?.cancel();
    handleRef.current = null;
    setActive(null);
    setPhase(partsDone > 0 ? 'ready' : 'idle');
  }, [partsDone]);

  /**
   * Send `current`'s parts from `from` on, one at a time, until one fails or
   * all are done. A reply that fills its room (a small model's few findings,
   * or any reply cut off at its limit) is followed by another request about
   * the same part for the issues it had no room for, until one comes back
   * with nothing new.
   */
  const reviewParts = useCallback(
    (current: ReviewRun, from: number) => {
      const parts = current.requests.length;
      const step = (index: number, pass: number, reported: readonly string[]) => {
        const requestId = ++requestRef.current;
        let settled = false;
        setPhase('running');
        setError(null);
        setActive({ part: index, more: pass > 0 });
        const next = () => {
          if (index + 1 < parts) {
            step(index + 1, 0, []);
          } else {
            setActive(null);
            setPhase('ready');
          }
        };
        const reviewStep = { part: index, pass, reported };
        const request = reviewStepRequest(current, reviewStep);
        const handle = knowledgeAi.chat(request, (event: AiChatEvent) => {
          if (
            requestRef.current !== requestId ||
            event.kind === 'delta' ||
            event.kind === 'progress' ||
            event.kind === 'knowledge'
          )
            return;
          settled = true;
          handleRef.current = null;
          // A follow-up only looks for more: when it fails, the part's own
          // findings still stand, so the review moves on and says there may be more.
          const fail = (message: string) => {
            if (pass > 0) {
              setCutOff(true);
              next();
              return;
            }
            setError(message);
            setActive(null);
            setPhase('error');
          };
          if (event.kind === 'error') {
            fail(event.error.message);
            return;
          }
          // The same reading the headless review (and so the docbench pack) uses.
          const result = readReviewReply(current, reviewStep, {
            text: event.completion.text,
            truncated: event.completion.finishReason === 'length',
          });
          if (result.kind === 'unreadable') {
            fail(result.message);
            return;
          }
          setReviewModel(event.completion.model || null);
          if (result.dropped > 0) setDropped((count) => count + result.dropped);
          // Each request numbers its findings from 1; the panel needs one id each.
          setFindings((existing) => numberReviewFindings(existing, result.fresh));
          // The part's own findings are in; asking it for more is extra.
          if (pass === 0) setPartsDone(index + 1);
          if (result.followUp) {
            step(result.followUp.part, result.followUp.pass, result.followUp.reported);
            return;
          }
          if (result.cutOff) setCutOff(true);
          next();
        });
        if (!settled) handleRef.current = handle;
      };
      step(from, 0, []);
    },
    [knowledgeAi],
  );

  const runReview = useCallback(() => {
    if (!style) return;
    handleRef.current?.cancel();
    handleRef.current = null;
    requestRef.current += 1;
    setCutOff(false);
    setDropped(0);
    setActive(null);
    setReviewedStyle(style);
    setRun(null);
    setPartsDone(0);
    setSkippedParts([]);
    setFindings([]);
    setResolvedIds(new Set());
    setApplyErrorId(null);
    setShown(null);
    setPendingReveal(null);
    setError(null);
    const start = startReviewRun(markdownSource, style, contextWindow);
    if (start.kind === 'empty') {
      setReviewedSource(markdownSource);
      setPhase('ready');
      return;
    }
    if (start.kind === 'too-long') {
      setError(start.message);
      setPhase('error');
      return;
    }
    const current = start.run;
    setRun(current);
    setReviewedSource(markdownSource);
    resetKnowledge();
    reviewParts(current, 0);
  }, [markdownSource, style, contextWindow, resetKnowledge, reviewParts]);

  /** Pick up at the next part: after Stop, or to retry the part that failed. */
  const continueReview = useCallback(() => {
    if (run && partsDone < run.requests.length) reviewParts(run, partsDone);
  }, [run, partsDone, reviewParts]);

  const skipPart = useCallback(() => {
    if (!run || partsDone >= run.requests.length) return;
    const next = partsDone + 1;
    setSkippedParts((current) => [...current, partsDone]);
    setPartsDone(next);
    if (next < run.requests.length) {
      reviewParts(run, next);
    } else {
      setError(null);
      setPhase('ready');
    }
  }, [run, partsDone, reviewParts]);

  useEffect(
    () => () => {
      requestRef.current += 1;
      handleRef.current?.cancel();
      handleRef.current = null;
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

  const unrevealable = useCallback(
    (id: string) =>
      setShown({ id, note: 'DocBlocks could not select this text in this view. Try Source view.' }),
    [],
  );

  // Select the text in the document, finding where it went if it has changed.
  const showFinding = (finding: AiReviewFinding) => {
    const location = locateReviewExcerpt(
      markdownSource,
      run?.source ?? reviewedSource,
      finding.originalText,
    );
    if (!location) {
      setShown({ id: finding.id, note: 'This text is no longer in the document.' });
      return;
    }
    setShown({
      id: finding.id,
      note: location.exact
        ? null
        : location.start === location.end
          ? 'This text was removed after the review. The caret marks where it was.'
          : 'This text has changed since the review. Its closest match is selected.',
    });
    const target = { activeView, tiptapEditor, monacoEditor };
    if (layoutMode === 'document' && canReveal(target)) {
      if (!revealSourceRange(target, markdownSource, location.start, location.end)) {
        unrevealable(finding.id);
      }
      return;
    }
    // Preview shows no caret; another layout shows one block at a time.
    if (activeView === 'preview') setActiveView('wysiwyg');
    if (layoutMode !== 'document') {
      goToBlockByLine(markdownSource.slice(0, location.start).split('\n').length);
    }
    setPendingReveal({ id: finding.id, location });
  };

  // Finish a reveal once the view switch or block change it waited for has rendered.
  useEffect(() => {
    if (!pendingReveal) return;
    const target = { activeView, tiptapEditor, monacoEditor };
    if (!canReveal(target)) return;
    const frame = requestAnimationFrame(() => {
      setPendingReveal(null);
      const { id, location } = pendingReveal;
      if (!revealSourceRange(target, markdownSource, location.start, location.end)) {
        unrevealable(id);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingReveal, activeView, tiptapEditor, monacoEditor, markdownSource, unrevealable]);

  const visibleFindings = findings.filter((finding) => !resolvedIds.has(finding.id));
  const documentChanged = reviewedSource !== null && markdownSource !== reviewedSource;
  const reviewedLabel = reviewedStyle ? AI_REVIEW_STYLE_DEFINITIONS[reviewedStyle].label : null;
  const partCount = run?.requests.length ?? 0;
  const inParts = partCount > 1;
  const unfinished = run !== null && partsDone < partCount;
  // Picking up a stopped or failed review only makes sense in its own style;
  // another style is a new review.
  const resumable = inParts && unfinished && phase !== 'running' && style === run?.style;
  const reviewLabel =
    phase === 'idle' || style !== reviewedStyle ? 'Review document' : 'Review again';

  return (
    <aside className="db-ai-review-panel" aria-label="AI document review">
      <div className="db-ai-review-header">
        <div>
          <h2>AI review</h2>
          {phase === 'ready' && (
            <span className="db-ai-review-count">
              {visibleFindings.length} {visibleFindings.length === 1 ? 'finding' : 'findings'}
              {reviewedLabel && ` · ${reviewedLabel}`}
            </span>
          )}
        </div>
        <button
          type="button"
          className="db-close-button db-ai-review-close"
          onClick={onClose}
          aria-label="Close AI review"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="db-ai-review-actions">
        <label className="db-ai-field db-ai-review-style">
          Review style
          {/* Choosing never starts a review: arrowing through a closed list
              fires a change for each option it passes. */}
          <select
            value={style ?? ''}
            disabled={phase === 'running'}
            aria-describedby={style ? styleDescriptionId : undefined}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (isAiReviewStyle(next)) setStyle(next);
            }}
          >
            <option value="" disabled>
              Choose a review style…
            </option>
            {AI_REVIEW_STYLES.map((option) => (
              <option key={option} value={option}>
                {AI_REVIEW_STYLE_DEFINITIONS[option].label}
              </option>
            ))}
          </select>
        </label>
        {style && (
          <p id={styleDescriptionId} className="db-ai-review-style-description">
            {AI_REVIEW_STYLE_DEFINITIONS[style].description}
          </p>
        )}
        {/* The first button is the one to press next. */}
        <div className="db-ai-review-buttons">
          {phase === 'running' ? (
            <button type="button" onClick={cancelReview}>
              Stop review
            </button>
          ) : resumable && phase === 'error' ? (
            <>
              <button type="button" onClick={continueReview}>
                Retry part {partsDone + 1}
              </button>
              <button type="button" onClick={skipPart}>
                Skip part {partsDone + 1}
              </button>
              <button type="button" onClick={runReview}>
                Start over
              </button>
            </>
          ) : resumable ? (
            <>
              <button type="button" onClick={continueReview}>
                Continue review
              </button>
              <button type="button" onClick={runReview}>
                Start over
              </button>
            </>
          ) : (
            <button type="button" disabled={!style} onClick={runReview}>
              {reviewLabel}
            </button>
          )}
        </div>
      </div>

      {phase === 'running' && (
        <div className="db-ai-review-empty" role="status">
          <span className="db-ai-spinner" aria-hidden="true" /> {reviewingText(active, partCount)}
        </div>
      )}
      {phase !== 'idle' && knowledge && (
        <div className="db-ai-review-knowledge">
          <AiKnowledgeIndicator knowledge={knowledge} />
        </div>
      )}
      {phase === 'error' && error && (
        <div className="db-ai-review-empty db-ai-error" role="alert">
          {inParts && unfinished && `Part ${partsDone + 1} of ${partCount} could not be reviewed. `}
          {error}
        </div>
      )}
      {phase === 'ready' && inParts && unfinished && (
        <div className="db-ai-review-stale" role="status">
          Stopped after {partsDone} of {partCount} parts, so the rest of the document has not been
          reviewed.
        </div>
      )}
      {phase !== 'running' && skippedParts.length > 0 && (
        <div className="db-ai-review-stale" role="status">
          {partsWere(skippedParts)} skipped, so findings there may be missing.
        </div>
      )}
      {phase !== 'running' && dropped > 0 && (
        <div className="db-ai-review-stale" role="status">
          {dropped === 1
            ? 'The AI returned 1 finding DocBlocks could not read, so it was left out.'
            : `The AI returned ${dropped} findings DocBlocks could not read, so they were left out.`}
        </div>
      )}
      {cutOff && phase === 'ready' && (
        <div className="db-ai-review-stale" role="status">
          {inParts
            ? 'The AI ran out of room in at least one part, so there may be more findings.'
            : `The AI ran out of room after ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}, so there may be more.`}{' '}
          After you apply these, review again to look for others.
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
          {findings.length > 0
            ? 'All findings have been handled.'
            : unfinished
              ? 'Nothing found in the parts reviewed so far.'
              : 'Nothing to report.'}
        </div>
      )}

      <ol className="db-ai-review-list">
        {visibleFindings.map((finding) => {
          const canApply =
            finding.replacement !== null &&
            findUniqueExcerpt(markdownSource, finding.originalText) !== null;
          return (
            // A click anywhere on the card shows its text, for the pointer; the
            // Show in document button does the same from the keyboard.
            <li
              key={finding.id}
              className={`db-ai-review-finding db-ai-review-item${shown?.id === finding.id ? ' db-ai-review-item--shown' : ''}`}
              onClick={(event) => {
                if ((event.target as Element).closest('button')) return;
                // Selecting the card's text to copy it is not a request to go there.
                const selection = window.getSelection();
                if (
                  selection &&
                  !selection.isCollapsed &&
                  event.currentTarget.contains(selection.anchorNode)
                ) {
                  return;
                }
                showFinding(finding);
              }}
            >
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
              {shown?.id === finding.id && shown.note && (
                <p className="db-ai-review-locate-note" role="status">
                  {shown.note}
                </p>
              )}
              {applyErrorId === finding.id && (
                <p className="db-ai-error" role="alert">
                  This text no longer has one exact match. Review the document again before applying
                  it.
                </p>
              )}
              <div className="db-ai-review-finding-actions">
                <button
                  type="button"
                  className="db-ai-review-show"
                  onClick={() => showFinding(finding)}
                >
                  Show in document
                </button>
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
      <p className="db-ai-review-disclaimer">
        AI suggestions can be wrong. Review each change.
        {phase === 'ready' && findings.length > 0 && (
          <>
            {' '}
            <AiReportButton
              feature={reviewedLabel ? `Review document (${reviewedLabel})` : 'Review document'}
              getOutput={() => formatReviewFindings(findings)}
              model={reviewModel}
            />
          </>
        )}
      </p>
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
