import React, { useState, useCallback, useEffect, useRef } from 'react';
import { EditorShell } from '@bendyline/squisq-editor-react';
import { MediaContext } from '@bendyline/squisq-react';
import '@bendyline/squisq-editor-react/styles';
import '@bendyline/docblocks-react/styles';
import type { ExtensionToWebviewMessage } from '../../src/messages.js';
import { createDebouncedEditPoster, type DebouncedEditPoster } from './debouncedEditPoster.js';
import { VscodeExportButton } from './VscodeExportButton.js';
import { createVscodeExportBridge, type VscodeExportBridge } from './vscodeExportBridge.js';
import { createVscodeMediaBridge, type VscodeMediaBridge } from './vscodeMediaProvider.js';
import { getVscodeApi } from './vscodeApi.js';

const vscode = getVscodeApi();

export function VscodeEditor() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [editorKey, setEditorKey] = useState(0);
  const [mediaBridge, setMediaBridge] = useState<VscodeMediaBridge | null>(null);
  const [exportBridge, setExportBridge] = useState<VscodeExportBridge | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const markdownRef = useRef<string | null>(null);
  const fileNameRef = useRef<string | null>(null);
  const editPosterRef = useRef<DebouncedEditPoster | null>(null);

  useEffect(() => {
    function handleMessage(event: MessageEvent<ExtensionToWebviewMessage>) {
      const msg = event.data;
      switch (msg.type) {
        case 'setContent':
          if (msg.content === markdownRef.current && msg.fileName === fileNameRef.current) return;
          markdownRef.current = msg.content;
          fileNameRef.current = msg.fileName;
          setMarkdown(msg.content);
          setFileName(msg.fileName);
          setEditorKey((key) => key + 1);
          break;
        case 'themeChange':
          setTheme(msg.theme);
          break;
      }
    }

    window.addEventListener('message', handleMessage);

    // Signal to the extension that we're ready to receive content
    vscode.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const editPoster = createDebouncedEditPoster((message) => vscode.postMessage(message), 300);
    editPosterRef.current = editPoster;

    return () => {
      editPoster.dispose();
      editPosterRef.current = null;
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 's' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      editPosterRef.current?.flush();
      const content = markdownRef.current;
      if (content !== null) vscode.postMessage({ type: 'save', content });
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

  // Debounced change handler — sends edits back to extension
  const handleChange = useCallback((source: string) => {
    markdownRef.current = source;
    setMarkdown(source);
    editPosterRef.current?.schedule(source);
  }, []);

  if (markdown === null || mediaBridge === null || exportBridge === null) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--vscode-foreground, #ccc)',
          fontFamily: 'var(--vscode-font-family, sans-serif)',
        }}
      >
        Loading...
      </div>
    );
  }

  return (
    <div className="db-shell db-vscode-editor" data-theme={theme}>
      <MediaContext.Provider value={mediaBridge.mediaProvider}>
        <EditorShell
          key={editorKey}
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
      </MediaContext.Provider>
    </div>
  );
}
