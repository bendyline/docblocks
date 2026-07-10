/**
 * GitDiffView — read-only Monaco side-by-side diff.
 *
 * Monaco is never statically imported: squisq's useMonacoLoader() lazily
 * imports the editor bundle once per page and hands back the namespace.
 * The diff editor and both text models are created imperatively into a
 * host div and disposed on unmount (the classic Monaco leak). Content and
 * theme changes update the existing editor without recreating it.
 */

import { useEffect, useRef } from 'react';
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
  theme: 'light' | 'dark';
  /** Optional column headers rendered above the two panes. */
  labels?: { original: string; modified: string };
}

function languageFor(fileName: string): string {
  const detected = detectLanguageFromFileName(fileName);
  if (detected) return detected;
  return fileName.toLowerCase().endsWith('.md') ? 'markdown' : 'plaintext';
}

export function GitDiffView({ original, modified, fileName, theme, labels }: GitDiffViewProps) {
  const { monaco, ready } = useMonacoLoader();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<DiffEditorInstance | null>(null);
  const modelsRef = useRef<{ original: TextModel; modified: TextModel } | null>(null);

  const language = languageFor(fileName);

  // Create the editor once monaco settles; dispose editor AND models on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!monaco || !host) return;
    const originalModel = monaco.editor.createModel('', 'plaintext');
    const modifiedModel = monaco.editor.createModel('', 'plaintext');
    const editor = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      renderSideBySide: true,
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

  // React to theme prop changes.
  useEffect(() => {
    if (!monaco) return;
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [monaco, theme]);

  if (!ready) {
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
