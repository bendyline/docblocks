import React, { useState, useCallback, useEffect, useRef } from 'react';
import { EditorShell } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import type { ExtensionToWebviewMessage } from '../../src/messages.js';
import { getVscodeApi } from './vscodeApi.js';

const vscode = getVscodeApi();

export function VscodeEditor() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  // Track the last version we received to prevent echo loops
  const lastVersionRef = useRef<number>(0);
  // Track whether the current change originated from the webview
  const isLocalEditRef = useRef(false);

  // Listen for messages from the extension host
  useEffect(() => {
    function handleMessage(event: MessageEvent<ExtensionToWebviewMessage>) {
      const msg = event.data;
      switch (msg.type) {
        case 'setContent':
          // Skip if this is an echo of our own edit
          if (isLocalEditRef.current && msg.version === lastVersionRef.current + 1) {
            isLocalEditRef.current = false;
            lastVersionRef.current = msg.version;
            return;
          }
          lastVersionRef.current = msg.version;
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
      isLocalEditRef.current = true;
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
