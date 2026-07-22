import React, { lazy, Suspense, useState, useCallback, useEffect, useMemo, useRef } from 'react';
// The DocPlayer (slideshow / video preview) ships its own stylesheet in
// @bendyline/squisq-react. docblocks-react/styles only pulls in squisq's
// *editor* styles, not the player's, so it must be imported explicitly here —
// exactly as the site and desktop renderers do in their main.tsx. Without it
// the player loses `.doc-player { max-height: 100% }` (plus its background and
// block layout), so a tall slide overflows the pane and pushes the slideshow /
// video controls off the bottom. Load it before docblocks-react/styles to match
// the proven site/desktop cascade order.
import '@bendyline/squisq-react/styles';
import '@bendyline/docblocks-react/styles';
import {
  pickEmptyDocumentPrompt,
  useResponsivePreviewViewportPreset,
} from '@bendyline/docblocks-react/editor';
import { resolveWriteCanvasFonts } from '@bendyline/docblocks-react/settings';
import type {
  DocBlocksAccentColor,
  DocumentSessionMessageStatus,
  ExtensionToWebviewMessage,
  VscodeEditorSettings,
  VscodeWriteCanvasSettings,
} from '@bendyline/docblocks/vscode';
import {
  DEFAULT_VSCODE_WRITE_CANVAS_SETTINGS,
  parseExtensionToWebviewMessage,
} from '@bendyline/docblocks/vscode';
import { createVscodeExportBridge, type VscodeExportBridge } from './vscodeExportBridge.js';
import { createVscodeMediaBridge, type VscodeMediaBridge } from './vscodeMediaProvider.js';
import { isAutoSavePending } from './autosaveStatus.js';
import { readVscodeBodyTheme, type VscodeColorScheme } from './vscodeBodyTheme.js';
import { getVscodeApi } from './vscodeApi.js';
import { WebviewDocumentClient, type WebviewDocumentScope } from './webviewDocumentClient.js';
import { VscodeWebviewRecovery } from './webviewRecovery.js';
import { VscodeFindButton } from './VscodeFindButton.js';
import { preloadMonacoRuntime } from './monacoRuntime.js';
import { markdownUsesMonacoWidget } from './optionalEditorRuntimes.js';

const vscode = getVscodeApi();

// The host cannot render an editor until the extension sends a document.
// Keep the large Squisq implementation out of the startup entry and load it
// only after that document and its media/export bridges are ready.
const EditorShell = lazy(async () => {
  return import('./LazyEditorShell.js');
});
const VscodeExportButton = lazy(() =>
  import('./VscodeExportButton.js').then((module) => ({ default: module.VscodeExportButton })),
);
const VscodeSettingsButton = lazy(() =>
  import('./VscodeSettingsButton.js').then((module) => ({ default: module.VscodeSettingsButton })),
);

const DEFAULT_EDITOR_SETTINGS: VscodeEditorSettings = {
  autoSave: false,
  accentColor: 'brown',
  writeCanvasSettings: { ...DEFAULT_VSCODE_WRITE_CANVAS_SETTINGS },
};

// Keep host capability decisions together at the EditorShell boundary. VS Code
// webviews cannot reliably grant microphone, camera, or screen-capture
// permission, while ordinary file-backed images and media still work.
const VSCODE_EDITOR_MEDIA_CAPABILITIES = Object.freeze({ allowRecording: false });
const TOOLBAR_EDIT_INTENT_TIMEOUT_MS = 250;

export function VscodeEditor() {
  const defaultPreviewViewportPreset = useResponsivePreviewViewportPreset();
  const [markdown, setMarkdown] = useState<string | null>(null);
  // Seed from the class VS Code stamped on <body> before this script ran, so
  // the first painted frame already matches VS Code. The host's `themeChange`
  // only arrives after a ready round-trip; a hardcoded default would paint the
  // wrong theme until then and visibly flip. `themeChange` still drives live
  // theme switches below.
  const [theme, setTheme] = useState<VscodeColorScheme>(readVscodeBodyTheme);
  const [editorScope, setEditorScope] = useState<WebviewDocumentScope | null>(null);
  const [mediaBridge, setMediaBridge] = useState<VscodeMediaBridge | null>(null);
  const [exportBridge, setExportBridge] = useState<VscodeExportBridge | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [settings, setSettings] = useState<VscodeEditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [sessionStatus, setSessionStatus] = useState<DocumentSessionMessageStatus>('idle');
  const [recoveryConflict, setRecoveryConflict] = useState<string | null>(null);
  const [findMode, setFindMode] = useState(false);
  const markdownRef = useRef<string | null>(null);
  const fileNameRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const documentClientRef = useRef(new WebviewDocumentClient());
  const recoveryRef = useRef<VscodeWebviewRecovery | null>(null);
  const nextSaveRequestId = useRef(1);
  const transientEditIntentTimerRef = useRef<number | null>(null);
  if (!recoveryRef.current) recoveryRef.current = new VscodeWebviewRecovery(vscode);
  const recovery = recoveryRef.current;

  useEffect(() => {
    function handleMessage(event: MessageEvent<unknown>) {
      const msg: ExtensionToWebviewMessage | null = parseExtensionToWebviewMessage(event.data);
      if (!msg) return;
      switch (msg.type) {
        case 'setContent':
          {
            const recoverPriorRenderer = activeSessionIdRef.current === null;
            const scope = documentClientRef.current.acceptContent(msg);
            const recoveryStart = recovery.beginSession(msg.content, recoverPriorRenderer);
            let nextContent = msg.content;

            if (recoveryStart.kind === 'restore') {
              documentClientRef.current.armEdits(scope);
              const recoveredEdit = documentClientRef.current.createEdit(
                scope,
                recoveryStart.content,
              );
              if (recoveredEdit) {
                recovery.recordEdit(recoveredEdit.clientRevision, recoveryStart.content);
                vscode.postMessage(recoveredEdit);
                nextContent = recoveryStart.content;
              }
              setRecoveryConflict(null);
            } else if (recoveryStart.kind === 'conflict') {
              setRecoveryConflict(recoveryStart.content);
            } else {
              setRecoveryConflict(null);
            }

            activeSessionIdRef.current = msg.sessionId;
            if (markdownUsesMonacoWidget(nextContent)) {
              // Code-fence widgets will request Monaco when the Write canvas
              // mounts. Start that large import alongside the editor chunk
              // instead of discovering it only after Squisq has rendered.
              void preloadMonacoRuntime().catch(() => undefined);
            }
            setSessionStatus('saved');
            setEditorScope(scope);
            if (nextContent !== markdownRef.current || msg.fileName !== fileNameRef.current) {
              markdownRef.current = nextContent;
              fileNameRef.current = msg.fileName;
              setMarkdown(nextContent);
              setFileName(msg.fileName);
            }
          }
          break;
        case 'editAcknowledged':
          if (msg.sessionId === activeSessionIdRef.current && msg.accepted) {
            recovery.acknowledgeEdit(msg.clientRevision, msg.sessionRevision);
          }
          break;
        case 'saveResult':
          // Full persistence notices render in VS Code's native status bar.
          break;
        case 'sessionState':
          if (msg.sessionId === activeSessionIdRef.current) {
            setSessionStatus(msg.status);
            recovery.acknowledgePersisted(msg.persistedRevision);
          }
          break;
        case 'themeChange':
          setTheme(msg.theme);
          break;
        case 'editorSettings':
          setSettings(msg.settings);
          break;
      }
    }

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handleMessage);
  }, [recovery]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 's' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      const requestId = nextSaveRequestId.current;
      nextSaveRequestId.current += 1;
      const message = documentClientRef.current.createSave(requestId);
      if (!message) return;
      vscode.postMessage(message);
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  useEffect(() => {
    const bridge = createVscodeMediaBridge((message) => vscode.postMessage(message));
    setMediaBridge(bridge);
    return () => bridge.dispose();
  }, []);

  useEffect(() => {
    const bridge = createVscodeExportBridge(
      (message) => vscode.postMessage(message),
      () => markdownRef.current,
      () => fileNameRef.current,
    );
    setExportBridge(bridge);
    return () => bridge.dispose();
  }, []);

  // Post every complete editor snapshot immediately. The extension host owns
  // the debounce and serialized persistence queue, so closing the webview
  // cannot strand a timer-held draft in renderer memory.
  const handleChange = useCallback(
    (source: string) => {
      if (source === markdownRef.current || !editorScope) return;
      const message = documentClientRef.current.createEdit(editorScope, source);
      if (!message) return;
      recovery.recordEdit(message.clientRevision, source);
      markdownRef.current = source;
      setMarkdown(source);
      vscode.postMessage(message);
    },
    [editorScope, recovery],
  );

  // EditorShell can emit a normalized WYSIWYG snapshot while it hydrates or
  // responds to navigation. Only content-changing browser input may arm the
  // first edit; the client additionally rejects a whitespace-only delta.
  const armEditorEdits = useCallback(
    (substantive: boolean) => {
      if (editorScope) documentClientRef.current.armEdits(editorScope, substantive);
    },
    [editorScope],
  );

  const armEditorEditsForBeforeInput = useCallback(
    (event: React.FormEvent<HTMLDivElement>) => {
      const substantive = classifyBeforeInput(event.nativeEvent);
      if (substantive !== null) armEditorEdits(substantive);
    },
    [armEditorEdits],
  );

  const armEditorEditsForPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData.getData('text/plain');
      armEditorEdits(text === '' || /\S/u.test(text));
    },
    [armEditorEdits],
  );

  const armEditorEditsForCut = useCallback(() => {
    const selected = window.getSelection()?.toString() ?? '';
    armEditorEdits(selected === '' || /\S/u.test(selected));
  }, [armEditorEdits]);

  const armEditorEditsForDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const text = event.dataTransfer.getData('text/plain');
      armEditorEdits(event.dataTransfer.files.length > 0 || text === '' || /\S/u.test(text));
    },
    [armEditorEdits],
  );

  const armEditorEditsForKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const substantive = classifyDocumentEditKey(event);
      if (substantive !== null) armEditorEdits(substantive);
    },
    [armEditorEdits],
  );

  const armEditorEditsForControl = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isDocumentMutationControl(event.target) || editorScope === null) return;
      documentClientRef.current.armEdits(editorScope);
      if (transientEditIntentTimerRef.current !== null) {
        window.clearTimeout(transientEditIntentTimerRef.current);
      }
      // A direct toolbar command updates EditorShell synchronously, then its
      // host callback arrives through a React effect. If this click produced
      // no document change, revoke the unused intent promptly so a later
      // normalization callback cannot borrow it.
      transientEditIntentTimerRef.current = window.setTimeout(() => {
        documentClientRef.current.disarmEdits(editorScope);
        transientEditIntentTimerRef.current = null;
      }, TOOLBAR_EDIT_INTENT_TIMEOUT_MS);
    },
    [editorScope],
  );

  useEffect(
    () => () => {
      if (transientEditIntentTimerRef.current !== null) {
        window.clearTimeout(transientEditIntentTimerRef.current);
      }
    },
    [],
  );

  const handleAutoSaveChange = useCallback((enabled: boolean) => {
    setSettings((current) => ({ ...current, autoSave: enabled }));
    vscode.postMessage({ type: 'setAutoSave', enabled });
  }, []);

  const handleAccentColorChange = useCallback((accentColor: DocBlocksAccentColor) => {
    setSettings((current) => ({ ...current, accentColor }));
    vscode.postMessage({ type: 'setAccentColor', accentColor });
  }, []);

  const handleWriteCanvasSettingsChange = useCallback(
    (writeCanvasSettings: VscodeWriteCanvasSettings) => {
      setSettings((current) => ({ ...current, writeCanvasSettings }));
      vscode.postMessage({ type: 'setWriteCanvasSettings', settings: writeCanvasSettings });
    },
    [],
  );

  const handleLinkClick = useCallback((href: string): boolean => {
    if (href.startsWith('#')) return false;
    vscode.postMessage({ type: 'openLink', href });
    return true;
  }, []);

  const handleMonacoIntent = useCallback((event: React.SyntheticEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest('[role="tab"][data-view="raw"]')) return;
    void preloadMonacoRuntime().catch(() => undefined);
  }, []);

  const editorGenerationKey = editorScope
    ? `${editorScope.sessionId}:${editorScope.generation}`
    : 'loading';
  const editorPlaceholder = useMemo(() => {
    // Keep the selection scoped to the same generation that remounts Squisq.
    void editorGenerationKey;
    return pickEmptyDocumentPrompt();
  }, [editorGenerationKey]);
  const autoSavePending = isAutoSavePending(settings.autoSave, sessionStatus);

  // Squisq's EditorShell takes numeric levers plus header/body CSS families; the
  // font scheme id lives in our own settings and resolves to families here.
  // The shared DocBlocks host stylesheet gives a named scheme precedence over
  // the active theme; `theme` omits the families and inherits as before.
  const editorWriteCanvasSettings = useMemo(
    () => ({
      textSize: settings.writeCanvasSettings.textSize,
      lineSpacing: settings.writeCanvasSettings.lineSpacing,
      ...resolveWriteCanvasFonts(settings.writeCanvasSettings.fontScheme),
    }),
    [settings.writeCanvasSettings],
  );

  const restoreRecoveredDraft = useCallback(() => {
    if (recoveryConflict === null || editorScope === null) return;
    documentClientRef.current.armEdits(editorScope);
    const message = documentClientRef.current.createEdit(editorScope, recoveryConflict);
    if (!message) return;
    recovery.recordEdit(message.clientRevision, recoveryConflict);
    markdownRef.current = recoveryConflict;
    setMarkdown(recoveryConflict);
    setRecoveryConflict(null);
    vscode.postMessage(message);
  }, [editorScope, recovery, recoveryConflict]);

  const discardRecoveredDraft = useCallback(() => {
    recovery.discard();
    setRecoveryConflict(null);
  }, [recovery]);

  if (markdown === null || editorScope === null) {
    return <EditorLoading />;
  }
  if (recoveryConflict !== null) {
    return (
      <RecoveryDecision
        fileName={fileName ?? 'this document'}
        onRestore={restoreRecoveredDraft}
        onDiscard={discardRecoveredDraft}
      />
    );
  }
  if (mediaBridge === null || exportBridge === null) return <EditorLoading />;

  return (
    <div
      className="db-shell db-vscode-editor"
      data-theme={theme}
      data-accent={settings.accentColor}
      style={{ position: 'relative' }}
      onBeforeInputCapture={armEditorEditsForBeforeInput}
      onKeyDownCapture={armEditorEditsForKey}
      onPasteCapture={armEditorEditsForPaste}
      onCutCapture={armEditorEditsForCut}
      onDropCapture={armEditorEditsForDrop}
      onClickCapture={armEditorEditsForControl}
      onPointerOverCapture={handleMonacoIntent}
      onFocusCapture={handleMonacoIntent}
    >
      <Suspense fallback={<EditorLoading />}>
        <EditorShell
          key={`${editorScope.sessionId}:${editorScope.generation}`}
          initialMarkdown={markdown}
          initialView="wysiwyg"
          defaultViewportPreset={defaultPreviewViewportPreset}
          onChange={handleChange}
          onLinkClick={handleLinkClick}
          colorScheme={theme}
          writeCanvasSettings={editorWriteCanvasSettings}
          height="100%"
          placeholder={editorPlaceholder}
          mediaProvider={mediaBridge.mediaProvider}
          allowRecording={VSCODE_EDITOR_MEDIA_CAPABILITIES.allowRecording}
          allowPresentationWindow={false}
          allowPresentationFullscreen={false}
          allowPrint={false}
          showFilesToggle={false}
          statusBarSlotRight={
            autoSavePending ? (
              <span className="squisq-status-item db-autosave-pending">Autosave pending</span>
            ) : undefined
          }
          findMode={findMode}
          onFindModeChange={setFindMode}
          toolbarSlotLeft={
            <Suspense fallback={null}>
              <VscodeSettingsButton
                settings={settings}
                onAutoSaveChange={handleAutoSaveChange}
                onAccentColorChange={handleAccentColorChange}
                onWriteCanvasSettingsChange={handleWriteCanvasSettingsChange}
              />
            </Suspense>
          }
          toolbarSlotRight={
            <>
              <VscodeFindButton active={findMode} onActiveChange={setFindMode} />
              <Suspense fallback={null}>
                <VscodeExportButton
                  selectedFile={fileName}
                  mediaContainer={exportBridge.contentContainer}
                  saveBlob={exportBridge.saveBlob}
                  resolveExportTarget={exportBridge.resolveExportTarget}
                  pickExportTarget={exportBridge.pickExportTarget}
                />
              </Suspense>
            </>
          }
        />
      </Suspense>
    </div>
  );
}

function RecoveryDecision({
  fileName,
  onRestore,
  onDiscard,
}: {
  fileName: string;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="docblocks-recovery-title"
      aria-describedby="docblocks-recovery-description"
      style={{
        boxSizing: 'border-box',
        maxWidth: 560,
        margin: '48px auto',
        padding: 24,
        color: 'var(--vscode-foreground)',
        background: 'var(--vscode-editor-background)',
        border: '1px solid var(--vscode-panel-border)',
      }}
    >
      <h2 id="docblocks-recovery-title">Unsaved DocBlocks draft found</h2>
      <p id="docblocks-recovery-description">
        {fileName} changed after this draft was recorded. Choose which content to open; DocBlocks
        will not overwrite the changed file automatically.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onDiscard}>
          Use current file
        </button>
        <button type="button" onClick={onRestore} autoFocus>
          Restore draft
        </button>
      </div>
    </div>
  );
}

function EditorLoading() {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--vscode-foreground, #ccc)',
        fontFamily: 'var(--vscode-font-family, sans-serif)',
      }}
    >
      Loading editor&hellip;
    </div>
  );
}

function classifyBeforeInput(event: Event): boolean | null {
  const inputType =
    'inputType' in event && typeof event.inputType === 'string' ? event.inputType : '';
  const data = 'data' in event && typeof event.data === 'string' ? event.data : null;
  if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop') return null;
  if (inputType.startsWith('insert')) {
    return data !== null && /\S/u.test(data);
  }
  if (inputType.startsWith('delete')) {
    const deletedText = event instanceof InputEvent ? readBeforeInputTargetText(event) : null;
    return deletedText === null || /\S/u.test(deletedText);
  }
  if (inputType.startsWith('format')) return true;
  // React may synthesize `beforeinput` from Chromium's `textInput` event. In
  // that path the text payload is present but `inputType` is empty.
  if (data !== null) return /\S/u.test(data);
  return null;
}

function readBeforeInputTargetText(event: InputEvent): string | null {
  if (typeof event.getTargetRanges !== 'function') return null;
  try {
    const ranges = event.getTargetRanges();
    if (ranges.length === 0) return null;
    return ranges
      .map((target) => {
        const range = document.createRange();
        range.setStart(target.startContainer, target.startOffset);
        range.setEnd(target.endContainer, target.endOffset);
        return range.toString();
      })
      .join('');
  } catch {
    return null;
  }
}

function classifyDocumentEditKey(event: React.KeyboardEvent<HTMLDivElement>): boolean | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === 'b' || key === 'i' || key === 'y' || key === 'z') return true;
    return null;
  }
  if (event.key.length === 1) return /\S/u.test(event.key);
  if (event.key === 'Backspace' || event.key === 'Delete') return true;
  if (event.key === 'Enter' || event.key === 'Tab') return false;
  return null;
}

function isDocumentMutationControl(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      [
        '.squisq-toolbar-button[data-btn-index]:not([aria-haspopup="menu"])',
        '[data-contextual] .squisq-toolbar-button',
        '.squisq-toolbar-overflow-item:not([aria-haspopup="menu"])',
        '.squisq-mermaid-type-card',
        '.squisq-code-snippet-language',
      ].join(','),
    ),
  );
}
