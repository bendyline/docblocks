import React, { lazy, Suspense, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { MediaContext } from '@bendyline/squisq-react';
import '@bendyline/docblocks-react/styles';
import { pickEmptyDocumentPrompt } from '@bendyline/docblocks-react/editor';
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

const vscode = getVscodeApi();

// The host cannot render an editor until the extension sends a document.
// Keep the large Squisq implementation out of the startup entry and load it
// only after that document and its media/export bridges are ready.
const EditorShell = lazy(async () => {
  // Worker setup is an enhancement; a host that cannot install language
  // workers must not make the document editor unavailable.
  await import('./setupMonacoWorkers.js').catch(() => undefined);
  return import('./LazyEditorShell.js');
});
const VscodeExportButton = lazy(() =>
  import('./VscodeExportButton.js').then((module) => ({ default: module.VscodeExportButton })),
);
const VscodeSettingsButton = lazy(() =>
  import('./VscodeSettingsButton.js').then((module) => ({ default: module.VscodeSettingsButton })),
);

const DEFAULT_EDITOR_SETTINGS: VscodeEditorSettings = {
  autoSave: true,
  accentColor: 'brown',
  writeCanvasSettings: { ...DEFAULT_VSCODE_WRITE_CANVAS_SETTINGS },
};

// Keep host capability decisions together at the EditorShell boundary. VS Code
// webviews cannot reliably grant microphone, camera, or screen-capture
// permission, while ordinary file-backed images and media still work.
const VSCODE_EDITOR_MEDIA_CAPABILITIES = Object.freeze({ allowRecording: false });

export function VscodeEditor() {
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

  // EditorShell can emit a normalized WYSIWYG snapshot while it hydrates.
  // Arm the current scope only from browser input that precedes a real user
  // edit, so opening a document remains byte-preserving and read-only.
  const armEditorEdits = useCallback(() => {
    if (editorScope) documentClientRef.current.armEdits(editorScope);
  }, [editorScope]);

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

  const editorGenerationKey = editorScope
    ? `${editorScope.sessionId}:${editorScope.generation}`
    : 'loading';
  const editorPlaceholder = useMemo(() => {
    // Keep the selection scoped to the same generation that remounts Squisq.
    void editorGenerationKey;
    return pickEmptyDocumentPrompt();
  }, [editorGenerationKey]);
  const autoSavePending = isAutoSavePending(settings.autoSave, sessionStatus);

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
      onBeforeInputCapture={armEditorEdits}
      onCompositionStartCapture={armEditorEdits}
      onKeyDownCapture={armEditorEdits}
      onPasteCapture={armEditorEdits}
      onCutCapture={armEditorEdits}
      onDropCapture={armEditorEdits}
      onPointerDownCapture={armEditorEdits}
    >
      <MediaContext.Provider value={mediaBridge.mediaProvider}>
        <Suspense fallback={<EditorLoading />}>
          <EditorShell
            key={`${editorScope.sessionId}:${editorScope.generation}`}
            initialMarkdown={markdown}
            onChange={handleChange}
            onLinkClick={handleLinkClick}
            colorScheme={theme}
            writeCanvasSettings={settings.writeCanvasSettings}
            height="100%"
            placeholder={editorPlaceholder}
            mediaProvider={mediaBridge.mediaProvider}
            allowRecording={VSCODE_EDITOR_MEDIA_CAPABILITIES.allowRecording}
            showFilesToggle={false}
            statusBarSlotRight={
              autoSavePending ? (
                <span className="squisq-status-item db-autosave-pending">Autosave pending</span>
              ) : undefined
            }
            findMode={findMode}
            onFindModeChange={setFindMode}
            toolbarSlotLeft={
              <VscodeSettingsButton
                settings={settings}
                onAutoSaveChange={handleAutoSaveChange}
                onAccentColorChange={handleAccentColorChange}
                onWriteCanvasSettingsChange={handleWriteCanvasSettingsChange}
              />
            }
            toolbarSlotRight={
              <>
                <VscodeFindButton active={findMode} onActiveChange={setFindMode} />
                <VscodeExportButton
                  selectedFile={fileName}
                  mediaContainer={exportBridge.contentContainer}
                  saveBlob={exportBridge.saveBlob}
                  resolveExportTarget={exportBridge.resolveExportTarget}
                  pickExportTarget={exportBridge.pickExportTarget}
                />
              </>
            }
          />
        </Suspense>
      </MediaContext.Provider>
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
