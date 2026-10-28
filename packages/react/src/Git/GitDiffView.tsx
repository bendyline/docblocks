/**
 * GitDiffView — read-only Monaco side-by-side diff.
 *
 * Monaco is never statically imported: squisq's useMonacoLoader() lazily
 * imports the editor bundle once per page and hands back the namespace.
 * The diff editor and both text models are created imperatively into a
 * host div and disposed on unmount (the classic Monaco leak). Content and
 * theme changes update the existing editor without recreating it.
 */

// The default import serves the classic JSX transform the Mocha suite runs.
import React, { useEffect, useRef } from 'react';
import {
  detectLanguageFromFileName,
  useMonacoLoader,
  type UseMonacoLoaderResult,
} from '@bendyline/squisq-editor-react';

type MonacoModule = NonNullable<UseMonacoLoaderResult['monaco']>;
type DiffEditorInstance = ReturnType<MonacoModule['editor']['createDiffEditor']>;
type TextModel = ReturnType<MonacoModule['editor']['createModel']>;

export interface GitDiffViewProps {
  original: string;
  modified: string;
  /** Used for language detection (markdown for .md, plain text otherwise). */
  fileName: string;
  /** Overrides detection from `fileName`. */
  language?: string;
  theme: 'light' | 'dark';
  /**
   * `auto` (default) is side by side when there is room and inline when
   * there is not. An explicit choice holds at any width.
   */
  layout?: 'auto' | 'side-by-side' | 'inline';
  /** Collapse unchanged regions to the changes and a few lines of context. */
  changesOnly?: boolean;
  /** Optional column headers rendered above the two panes. */
  labels?: { original: string; modified: string };
}

function languageFor(fileName: string): string {
  const detected = detectLanguageFromFileName(fileName);
  if (detected) return detected;
  return fileName.toLowerCase().endsWith('.md') ? 'markdown' : 'plaintext';
}

export function GitDiffView({
  original,
  modified,
  fileName,
  language: languageOverride,
  theme,
  layout = 'auto',
  changesOnly = false,
  labels,
}: GitDiffViewProps) {
  const language = languageOverride ?? languageFor(fileName);
  // Monaco registers languages on demand; ask for this one so the diff is highlighted.
  const loader = useMonacoLoader(language);
  // The namespace can already exist while this language is still loading, and
  // the host div only renders once ready: key every effect on readiness.
  const monaco = loader.ready ? loader.monaco : null;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<DiffEditorInstance | null>(null);
  const modelsRef = useRef<{ original: TextModel; modified: TextModel } | null>(null);

  // Create the editor once monaco settles; dispose editor AND models on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!monaco || !host) return;
    const originalModel = monaco.editor.createModel('', 'plaintext');
    const modifiedModel = monaco.editor.createModel('', 'plaintext');
    const editor = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    editorRef.current = editor;
    modelsRef.current = { original: originalModel, modified: modifiedModel };
    return () => {
      editorRef.current = null;
      modelsRef.current = null;
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [monaco]);

  // Sync content + language into the existing models — never recreate the editor.
  useEffect(() => {
    if (!monaco) return;
    const models = modelsRef.current;
    if (!models) return;
    if (models.original.getValue() !== original) models.original.setValue(original);
    if (models.modified.getValue() !== modified) models.modified.setValue(modified);
    monaco.editor.setModelLanguage(models.original, language);
    monaco.editor.setModelLanguage(models.modified, language);
  }, [monaco, original, modified, language]);

  // Switch views in place, keeping the scroll position.
  useEffect(() => {
    editorRef.current?.updateOptions({
      renderSideBySide: layout !== 'inline',
      useInlineViewWhenSpaceIsLimited: layout === 'auto',
      hideUnchangedRegions: { enabled: changesOnly },
      // Inline turns wrapping off for the hidden original side, and Monaco
      // (0.50) never turns it back on; side by side would show it clipped.
      wordWrapOverride2: 'inherit',
    });
  }, [monaco, layout, changesOnly]);

  // React to theme prop changes.
  useEffect(() => {
    if (!monaco) return;
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [monaco, theme]);

  if (!monaco) {
    return <div className="db-git-diff-loading">Loading diff…</div>;
  }

  return (
    <>
      {labels && (
        <div className="db-git-diff-labels">
          <span>{labels.original}</span>
          <span>{labels.modified}</span>
        </div>
      )}
      <div ref={hostRef} className="db-git-diff-host" />
    </>
  );
}
