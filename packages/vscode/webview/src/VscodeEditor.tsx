import React, { lazy, Suspense, useState, useCallback, useEffect, useRef } from 'react';
import { MediaContext } from '@bendyline/squisq-react';
import '@bendyline/squisq-editor-react/styles';
import '@bendyline/docblocks-react/styles';
import type {
  DocumentSessionMessageStatus,
  ExtensionToWebviewMessage,
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

export function VscodeEditor() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [editorScope, setEditorScope] = useState<WebviewDocumentScope | null>(null);
  const [mediaBridge, setMediaBridge] = useState<VscodeMediaBridge | null>(null);
  const [exportBridge, setExportBridge] = useState<VscodeExportBridge | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<DocumentSessionMessageStatus>('idle');
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
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
          break;
        case 'saveResult':
          if (!documentClientRef.current.isCurrentSession(msg.sessionId)) return;
          setSessionStatus(msg.ok ? 'saved' : 'error');
          setSessionMessage(msg.ok ? 'Saved' : (msg.message ?? 'The document could not be saved.'));
          break;
        case 'themeChange':
          setTheme(msg.theme);
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

  const resolveConflict = useCallback((choice: 'use-local' | 'use-external') => {
    const message = documentClientRef.current.createConflictResolution(choice);
    if (message) vscode.postMessage(message);
  }, []);

  if (markdown === null || editorScope === null || mediaBridge === null || exportBridge === null) {
    return <EditorLoading />;
  }

  return (
    <div className="db-shell db-vscode-editor" data-theme={theme} style={{ position: 'relative' }}>
      <MediaContext.Provider value={mediaBridge.mediaProvider}>
        <Suspense fallback={<EditorLoading />}>
          <EditorShell
            key={`${editorScope.sessionId}:${editorScope.generation}`}
            initialMarkdown={markdown}
            onChange={handleChange}
            colorScheme={theme}
            height="100%"
            mediaProvider={mediaBridge.mediaProvider}
            showFilesToggle={false}
            toolbarSlotRight={
              <VscodeExportButton
                selectedFile={fileName}
                mediaContainer={exportBridge.contentContainer}
                saveBlob={exportBridge.saveBlob}
                resolveExportTarget={exportBridge.resolveExportTarget}
                pickExportTarget={exportBridge.pickExportTarget}
              />
            }
          />
        </Suspense>
      </MediaContext.Provider>
      <DocumentSessionStatus
        status={sessionStatus}
        message={sessionMessage}
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
  onResolveConflict,
}: {
  status: DocumentSessionMessageStatus;
  message: string | null;
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
        alignItems: 'center',
        gap: 8,
        maxWidth: 'min(560px, calc(100% - 24px))',
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
      <span>{label}</span>
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
  );
}
