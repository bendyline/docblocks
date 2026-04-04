import React, { useState, useCallback, useEffect, useRef } from 'react';
import { EditorShell } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import type { ExtensionToWebviewMessage } from '../../src/messages.js';
import { getVscodeApi } from './vscodeApi.js';

const vscode = getVscodeApi();

export function VscodeEditor() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  // Flag set after we post an edit, cleared when we receive the echo back.
  // Prevents re-setting markdown from our own change.
  const awaitingEchoRef = useRef(false);

  useEffect(() => {
    function handleMessage(event: MessageEvent<ExtensionToWebviewMessage>) {
      const msg = event.data;
      switch (msg.type) {
        case 'setContent':
          if (awaitingEchoRef.current) {
            // This is the echo from our own edit — ignore it
            awaitingEchoRef.current = false;
            return;
          }
          setMarkdown(msg.content);
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

  // Debounced change handler — sends edits back to extension
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleChange = useCallback((source: string) => {
    setMarkdown(source);

    // Debounce edits to avoid flooding the extension host
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      awaitingEchoRef.current = true;
      vscode.postMessage({ type: 'edit', content: source });
    }, 300);
  }, []);

  if (markdown === null) {
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
    <EditorShell initialMarkdown={markdown} onChange={handleChange} theme={theme} height="100%" />
  );
}
