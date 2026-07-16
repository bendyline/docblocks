/** Deferred boundary for the large Squisq editor implementation. */
import { Fragment, useEffect } from 'react';
import {
  EditorShell,
  useEditorContext,
  type EditorShellProps,
} from '@bendyline/squisq-editor-react';

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
function VscodeSourceThemeSync({ colorScheme }: { colorScheme: 'light' | 'dark' }) {
  const { monacoEditor } = useEditorContext();

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
  toolbarSlotAfterActions,
  ...props
}: EditorShellProps) {
  return (
    <EditorShell
      {...props}
      colorScheme={colorScheme}
      toolbarSlotAfterActions={
        <Fragment>
          {toolbarSlotAfterActions}
          <VscodeSourceThemeSync colorScheme={colorScheme} />
        </Fragment>
      }
    />
  );
}
