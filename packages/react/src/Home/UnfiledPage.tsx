import { useEffect, useMemo, useState } from 'react';
import { isMarkdownFileName } from '@bendyline/docblocks/filesystem';
import type { KindFolder } from '@bendyline/docblocks/folders';
import type { WorkspaceIndexFile } from '@bendyline/docblocks/workspace-index';
import type { FolderChoice } from '../FolderPicker/folder-tree.js';
import { WorkspaceFolderPicker } from '../FolderPicker/WorkspaceFolderPicker.js';
import { CaptureBox } from './CaptureBox.js';
import { PageFrame } from './PageFrame.js';
import type { ShellPageContext } from './page-context.js';
import { PhoneInboxOffer } from './PhoneInboxOffer.js';

function folderLabel(path: string): string {
  return path ? path.split('/').join(' › ') : 'Top of the workspace';
}

function UnfiledItem({
  file,
  context,
  drawer,
  suggestion,
}: {
  file: WorkspaceIndexFile;
  context: ShellPageContext;
  /** The drawer's own path, and its name. */
  drawer: { readonly path: string; readonly name: string };
  suggestion: string | null;
}) {
  const actions = context.actions;
  const [busy, setBusy] = useState(false);
  const act = (work: Promise<void>) => {
    setBusy(true);
    void work.finally(() => setBusy(false));
  };
  const title = file.name.replace(/\.(?:md|markdown|mdown)$/i, '');
  const fileIn = (choice: FolderChoice) => {
    if (!actions) return;
    if (choice.workspaceId === context.workspaceId) {
      act(actions.fileTo(`/${file.path}`, `/${choice.path}`));
    } else if (context.fileInWorkspace) {
      act(context.fileInWorkspace(`/${file.path}`, choice));
    }
  };
  /** Folders a note cannot be filed in: the drawer, and anything inside it. */
  const unavailable = (choice: FolderChoice): string | null => {
    if (choice.workspaceId !== context.workspaceId) {
      return context.fileInWorkspace ? null : "Notes can't be moved to another workspace here.";
    }
    if (choice.path === drawer.path) return `It's already in ${drawer.name}.`;
    if (drawer.path && choice.path.startsWith(`${drawer.path}/`)) {
      return `That's inside ${drawer.name}, where notes wait to be filed.`;
    }
    return null;
  };
  return (
    <li className="db-unfiled-item" aria-busy={busy || undefined}>
      <div className="db-unfiled-main">
        <button
          type="button"
          className="db-task-title"
          onClick={() => context.openDocument(`/${file.path}`)}
        >
          {title}
        </button>
        <span className="db-task-where">
          {new Date(file.lastModified).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
          })}
        </span>
      </div>
      {actions && (
        <div className="db-unfiled-actions">
          {suggestion !== null && (
            <button
              type="button"
              className="db-page-primary"
              disabled={busy}
              onClick={() => act(actions.fileTo(`/${file.path}`, `/${suggestion}`))}
            >
              File in {folderLabel(suggestion)}
            </button>
          )}
          {isMarkdownFileName(file.name) && (
            <button
              type="button"
              className="db-page-secondary"
              disabled={busy}
              onClick={() => act(actions.makeTask(`/${file.path}`))}
            >
              Make it a task
            </button>
          )}
          {context.folderSource && (
            <WorkspaceFolderPicker
              label="File in…"
              triggerLabel={`File “${title}” in…`}
              triggerClassName="db-page-secondary"
              disabled={busy}
              source={context.folderSource}
              initial={
                suggestion !== null ? { workspaceId: context.workspaceId, path: suggestion } : null
              }
              unavailable={unavailable}
              onChoose={fileIn}
            />
          )}
          <button
            type="button"
            className="db-page-link db-page-link--danger"
            disabled={busy}
            onClick={() => act(actions.remove(`/${file.path}`))}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

export function UnfiledPage({
  context,
  folder,
}: {
  context: ShellPageContext;
  folder: KindFolder;
}) {
  const { index, generation, actions } = context;
  const prefix = folder.path ? `${folder.path}/` : '';
  const name = folder.path.slice(folder.path.lastIndexOf('/') + 1) || context.workspaceName;

  const files = useMemo(() => {
    if (!index) return [];
    return index
      .getFiles()
      .filter((file) => file.path.startsWith(prefix))
      .sort((left, right) => (left.lastModified < right.lastModified ? 1 : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, generation, prefix]);
  const drawer = useMemo(() => ({ path: folder.path, name }), [folder.path, name]);

  const suggestions = useSuggestedFolders(context, files, prefix);

  return (
    <PageFrame
      title={name}
      subtitle="Waiting to be filed"
      label={`${name}, waiting to be filed`}
      singlePane={context.singlePane}
      onShowFiles={context.onShowFiles}
    >
      {context.phoneInbox && <PhoneInboxOffer offer={context.phoneInbox} here />}
      {actions && (
        <CaptureBox
          label="Jot something down"
          placeholder="An idea to file later"
          today={context.today}
          readsDates={false}
          primary={{
            label: 'Save note',
            run: async (text) => (await actions.saveNote(text)) !== null,
          }}
        />
      )}
      {files.length === 0 ? (
        <p className="db-page-empty">
          {context.listing
            ? 'Looking through your notes…'
            : 'Nothing is waiting. Notes you jot down and things you drop on Home land here.'}
        </p>
      ) : (
        <ul className="db-unfiled-list">
          {files.map((file) => (
            <UnfiledItem
              key={file.path}
              file={file}
              context={context}
              drawer={drawer}
              suggestion={suggestions.get(file.path) ?? null}
            />
          ))}
        </ul>
      )}
    </PageFrame>
  );
}

/**
 * A folder each waiting note seems to belong in: where the passages nearest
 * to it in meaning (or in words, without semantic search) already live.
 */
function useSuggestedFolders(
  context: ShellPageContext,
  files: readonly WorkspaceIndexFile[],
  prefix: string,
): ReadonlyMap<string, string> {
  const [suggestions, setSuggestions] = useState<ReadonlyMap<string, string>>(new Map());
  const { index, generation } = context;
  useEffect(() => {
    if (!index?.find || index.getStatus().ranked !== true) {
      setSuggestions(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const found = new Map<string, string>();
      for (const file of files.slice(0, 20)) {
        if (!isMarkdownFileName(file.name)) continue;
        const document = index.getDocument(file.path);
        const query = [document?.title, document?.excerpt].filter(Boolean).join(' ').slice(0, 300);
        if (!query) continue;
        try {
          const hits = await index.find!(query, { limit: 8, perDocument: 1 });
          const home = hits.find((hit) => !hit.path.startsWith(prefix));
          if (home)
            found.set(file.path, home.path.slice(0, Math.max(0, home.path.lastIndexOf('/'))));
        } catch {
          // A failed search just leaves this note without a suggestion.
        }
        if (cancelled) return;
      }
      if (!cancelled) setSuggestions(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [index, generation, files, prefix]);
  return suggestions;
}
