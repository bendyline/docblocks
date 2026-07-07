import React, { useState, useCallback, useEffect, useRef } from 'react';
import { EditorShell } from '@bendyline/squisq-editor-react';
import { MediaContext } from '@bendyline/squisq-react';
import '@bendyline/squisq-editor-react/styles';
import type { ExtensionToWebviewMessage } from '../../src/messages.js';
import { createDebouncedEditPoster, type DebouncedEditPoster } from './debouncedEditPoster.js';
import { createVscodeMediaBridge, type VscodeMediaBridge } from './vscodeMediaProvider.js';
import { getVscodeApi } from './vscodeApi.js';

const vscode = getVscodeApi();

export function VscodeEditor() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [editorKey, setEditorKey] = useState(0);
  const [mediaBridge, setMediaBridge] = useState<VscodeMediaBridge | null>(null);
  const markdownRef = useRef<string | null>(null);
  const editPosterRef = useRef<DebouncedEditPoster | null>(null);

  useEffect(() => {
    function handleMessage(event: MessageEvent<ExtensionToWebviewMessage>) {
      const msg = event.data;
      switch (msg.type) {
        case 'setContent':
          if (msg.content === markdownRef.current) return;
          markdownRef.current = msg.content;
          setMarkdown(msg.content);
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
    const bridge = createVscodeMediaBridge((message) => vscode.postMessage(message));
    setMediaBridge(bridge);
    return () => bridge.dispose();
  }, []);

  // Debounced change handler — sends edits back to extension
  const handleChange = useCallback((source: string) => {
    markdownRef.current = source;
    setMarkdown(source);
    editPosterRef.current?.schedule(source);
  }, []);

  if (markdown === null || mediaBridge === null) {
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
    <MediaContext.Provider value={mediaBridge.mediaProvider}>
      <EditorShell
        key={editorKey}
        initialMarkdown={markdown}
        onChange={handleChange}
        colorScheme={theme}
        height="100%"
        mediaProvider={mediaBridge.mediaProvider}
        showFilesToggle={false}
      />
    </MediaContext.Provider>
  );
}
