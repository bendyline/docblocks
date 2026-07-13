import React, { lazy, Suspense, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { MediaContext } from '@bendyline/squisq-react';
import '@bendyline/squisq-editor-react/styles';
import '@bendyline/docblocks-react/styles';
import { pickEmptyDocumentPrompt } from '@bendyline/docblocks-react/editor';
import type {
  DocBlocksAccentColor,
  DocumentConflictDetailsMessage,
  DocumentSessionMessageStatus,
  ExtensionToWebviewMessage,
  VscodeEditorSettings,
} from '@bendyline/docblocks/vscode';
import { parseExtensionToWebviewMessage } from '@bendyline/docblocks/vscode';
import { createVscodeExportBridge, type VscodeExportBridge } from './vscodeExportBridge.js';
import { createVscodeMediaBridge, type VscodeMediaBridge } from './vscodeMediaProvider.js';
import { getVscodeApi } from './vscodeApi.js';
import { WebviewDocumentClient, type WebviewDocumentScope } from './webviewDocumentClient.js';

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
};

export function VscodeEditor() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [editorScope, setEditorScope] = useState<WebviewDocumentScope | null>(null);
  const [mediaBridge, setMediaBridge] = useState<VscodeMediaBridge | null>(null);
  const [exportBridge, setExportBridge] = useState<VscodeExportBridge | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<DocumentSessionMessageStatus>('idle');
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [conflictDetails, setConflictDetails] = useState<DocumentConflictDetailsMessage | null>(
    null,
  );
  const [settings, setSettings] = useState<VscodeEditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const markdownRef = useRef<string | null>(null);
  const fileNameRef = useRef<string | null>(null);
  const documentClientRef = useRef(new WebviewDocumentClient());
  const nextSaveRequestId = useRef(1);

  useEffect(() => {
    function handleMessage(event: MessageEvent<unknown>) {
      const msg: ExtensionToWebviewMessage | null = parseExtensionToWebviewMessage(event.data);
      if (!msg) return;
      switch (msg.type) {
        case 'setContent':
          setEditorScope(documentClientRef.current.acceptContent(msg));
          if (msg.content === markdownRef.current && msg.fileName === fileNameRef.current) return;
          markdownRef.current = msg.content;
          fileNameRef.current = msg.fileName;
          setMarkdown(msg.content);
          setFileName(msg.fileName);
          break;
        case 'editAcknowledged':
          if (!documentClientRef.current.isCurrentSession(msg.sessionId) || msg.accepted) return;
          setSessionStatus('error');
          setSessionMessage(msg.message ?? 'VS Code rejected this document edit.');
          break;
        case 'sessionState':
          if (!documentClientRef.current.isCurrentSession(msg.sessionId)) return;
          setSessionStatus(msg.status);
          setSessionMessage(msg.error);
          setConflictDetails(msg.conflict);
          break;
        case 'saveResult':
          if (!documentClientRef.current.isCurrentSession(msg.sessionId)) return;
          setSessionStatus(msg.ok ? 'saved' : 'error');
          setSessionMessage(msg.ok ? 'Saved' : (msg.message ?? 'The document could not be saved.'));
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
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 's' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      const requestId = nextSaveRequestId.current;
      nextSaveRequestId.current += 1;
      const message = documentClientRef.current.createSave(requestId);
      if (!message) return;
      setSessionStatus('saving');
      setSessionMessage('Saving…');
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
      markdownRef.current = source;
      setMarkdown(source);
      vscode.postMessage(message);
      setSessionStatus('dirty');
      setSessionMessage(null);
    },
    [editorScope],
  );

  // EditorShell can emit a normalized WYSIWYG snapshot while it hydrates.
  // Arm the current scope only from browser input that precedes a real user
  // edit, so opening a document remains byte-preserving and read-only.
  const armEditorEdits = useCallback(() => {
    if (editorScope) documentClientRef.current.armEdits(editorScope);
  }, [editorScope]);

  const resolveConflict = useCallback((choice: 'use-local' | 'use-external') => {
    const message = documentClientRef.current.createConflictResolution(choice);
    if (message) vscode.postMessage(message);
  }, []);

  const handleAutoSaveChange = useCallback((enabled: boolean) => {
    setSettings((current) => ({ ...current, autoSave: enabled }));
    vscode.postMessage({ type: 'setAutoSave', enabled });
  }, []);

  const handleAccentColorChange = useCallback((accentColor: DocBlocksAccentColor) => {
    setSettings((current) => ({ ...current, accentColor }));
    vscode.postMessage({ type: 'setAccentColor', accentColor });
  }, []);

  const editorGenerationKey = editorScope
    ? `${editorScope.sessionId}:${editorScope.generation}`
    : 'loading';
  const editorPlaceholder = useMemo(() => {
    // Keep the selection scoped to the same generation that remounts Squisq.
    void editorGenerationKey;
    return pickEmptyDocumentPrompt();
  }, [editorGenerationKey]);

  if (markdown === null || editorScope === null || mediaBridge === null || exportBridge === null) {
    return <EditorLoading />;
  }

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
            colorScheme={theme}
            height="100%"
            placeholder={editorPlaceholder}
            mediaProvider={mediaBridge.mediaProvider}
            showFilesToggle={false}
            toolbarSlotRight={
              <>
                <VscodeExportButton
                  selectedFile={fileName}
                  mediaContainer={exportBridge.contentContainer}
                  saveBlob={exportBridge.saveBlob}
                  resolveExportTarget={exportBridge.resolveExportTarget}
                  pickExportTarget={exportBridge.pickExportTarget}
                />
                <VscodeSettingsButton
                  settings={settings}
                  onAutoSaveChange={handleAutoSaveChange}
                  onAccentColorChange={handleAccentColorChange}
                />
              </>
            }
          />
        </Suspense>
      </MediaContext.Provider>
      <DocumentSessionStatus
        status={sessionStatus}
        message={sessionMessage}
        conflict={conflictDetails}
        onResolveConflict={resolveConflict}
      />
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

function DocumentSessionStatus({
  status,
  message,
  conflict,
  onResolveConflict,
}: {
  status: DocumentSessionMessageStatus;
  message: string | null;
  conflict: DocumentConflictDetailsMessage | null;
  onResolveConflict: (choice: 'use-local' | 'use-external') => void;
}) {
  if (status === 'idle' || (status === 'saved' && !message)) return null;

  const label =
    message ??
    (
      {
        dirty: 'Unsaved changes',
        saving: 'Saving…',
        saved: 'Saved',
        error: 'Save failed',
        conflict: 'This file changed outside DocBlocks. Choose which version to keep.',
        closed: 'Editor closed',
        idle: '',
      } satisfies Record<DocumentSessionMessageStatus, string>
    )[status];

  return (
    <div
      role={status === 'error' || status === 'conflict' ? 'alert' : 'status'}
      aria-live={status === 'error' || status === 'conflict' ? 'assertive' : 'polite'}
      style={{
        position: 'absolute',
        right: 12,
        bottom: 10,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 6,
        maxWidth: 'min(680px, calc(100% - 24px))',
        padding: '6px 10px',
        border: '1px solid var(--vscode-widget-border, rgba(127,127,127,.4))',
        borderRadius: 4,
        color: 'var(--vscode-notifications-foreground, var(--vscode-foreground, #ddd))',
        background:
          'var(--vscode-notifications-background, var(--vscode-editor-background, #252526))',
        boxShadow: '0 2px 8px rgba(0,0,0,.25)',
        fontFamily: 'var(--vscode-font-family, sans-serif)',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1 }}>{label}</span>
        {status === 'conflict' && (
          <>
            <button type="button" onClick={() => onResolveConflict('use-local')}>
              Keep mine
            </button>
            <button type="button" onClick={() => onResolveConflict('use-external')}>
              Use external
            </button>
          </>
        )}
      </div>
      {status === 'conflict' && conflict && <ConflictDetails details={conflict} />}
    </div>
  );
}

function ConflictDetails({ details }: { details: DocumentConflictDetailsMessage }) {
  const byteDelta =
    details.externalBytes === null ? null : details.externalBytes - details.localBytes;
  return (
    <div style={{ display: 'grid', gap: 4, lineHeight: 1.35 }}>
      <span>
        Your draft:{' '}
        {details.localEditedAt === null
          ? 'edit time unavailable'
          : `last edited ${formatObservedTime(details.localEditedAt)}`}
      </span>
      <span>
        Current version:{' '}
        {details.externalObservedAt === null
          ? 'observation time unavailable'
          : `observed ${formatObservedTime(details.externalObservedAt)}`}
      </span>
      <span>{formatExternalSaveState(details.externalIsDirty)}</span>
      <span>
        {details.externalBytes === null
          ? 'Current file: deleted'
          : `Size difference: ${formatSizeComparison(byteDelta ?? 0)}`}
      </span>
      <details>
        <summary style={{ cursor: 'pointer' }}>Advanced details</summary>
        <div style={{ display: 'grid', gap: 3, marginTop: 5 }}>
          <span>
            Your draft: {formatBytes(details.localBytes)} (UTF-8); VS Code document version{' '}
            {details.localBaseDocumentVersion}
          </span>
          <span>
            Current version: {formatEncodedSize(details.externalBytes)}; VS Code document version{' '}
            {details.externalDocumentVersion}
          </span>
          <span>
            Source: VS Code's shared document model. VS Code does not expose which process or
            extension made a text-document change.
          </span>
        </div>
      </details>
    </div>
  );
}

function formatObservedTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatEncodedSize(bytes: number | null): string {
  return bytes === null ? 'deleted' : `${formatBytes(bytes)} (UTF-8)`;
}

function formatBytes(bytes: number): string {
  return `${new Intl.NumberFormat().format(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

function formatSizeComparison(bytes: number): string {
  if (bytes === 0) return 'same byte count as your draft';
  const direction = bytes > 0 ? 'larger' : 'smaller';
  return `${formatBytes(Math.abs(bytes))} ${direction} than your draft`;
}

function formatExternalSaveState(isDirty: boolean | null): string {
  if (isDirty === true) return 'The current version has unsaved changes in VS Code';
  if (isDirty === false) return 'VS Code reports the current version saved';
  return 'The current version save state is unavailable';
}
