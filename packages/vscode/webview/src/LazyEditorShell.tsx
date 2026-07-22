/** Deferred boundary for the large Squisq editor implementation. */
import { Fragment, useEffect } from 'react';
import {
  EditorShell,
  useEditorContext,
  type EditorShellProps,
} from '@bendyline/squisq-editor-react/shell';
import { ensureMonacoWorkers } from './monacoRuntime.js';
import { markdownUsesMonacoWidget } from './optionalEditorRuntimes.js';

/**
 * Keep Monaco on the scheme selected by the VS Code host.
 *
 * Squisq normally maps `colorScheme` onto Monaco itself. Desktop VS Code can
 * nevertheless restore the Source editor with Monaco's shared light
 * theme after the shell has already mounted dark. Reapply the built-in Monaco
 * scheme once the Source editor exists and whenever VS Code changes themes.
 * The Monaco module remains lazy because this component does nothing until
 * Squisq publishes a mounted editor through its context.
 */
function VscodeMonacoIntegration({
  colorScheme,
  markdown,
}: {
  colorScheme: 'light' | 'dark';
  markdown: string;
}) {
  const { activeView, monacoEditor } = useEditorContext();
  const needsMonaco = activeView === 'raw' || markdownUsesMonacoWidget(markdown);

  useEffect(() => {
    if (!needsMonaco) return;

    // Importing the setup module only registers worker constructors. Vite's
    // worker chunks remain unfetched until Monaco asks for the matching
    // language service. Plain WYSIWYG documents never request this module.
    void ensureMonacoWorkers().catch(() => undefined);
  }, [needsMonaco]);

  useEffect(() => {
    if (!monacoEditor) return;

    let cancelled = false;
    void import('@bendyline/squisq-editor-react/monaco')
      .then((monaco) => {
        if (!cancelled) monaco.editor.setTheme(colorScheme === 'dark' ? 'vs-dark' : 'vs');
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [colorScheme, monacoEditor]);

  return null;
}

export default function VscodeEditorShell({
  colorScheme = 'light',
  initialMarkdown = '',
  toolbarSlotAfterActions,
  ...props
}: EditorShellProps) {
  return (
    <EditorShell
      {...props}
      initialMarkdown={initialMarkdown}
      colorScheme={colorScheme}
      toolbarSlotAfterActions={
        <Fragment>
          {toolbarSlotAfterActions}
          <VscodeMonacoIntegration colorScheme={colorScheme} markdown={initialMarkdown} />
        </Fragment>
      }
    />
  );
}
