/**
 * GitDiffDialog — full-size modal showing a file diff.
 *
 * Without a revision: working tree vs HEAD (HEAD side via the git host API,
 * working side via the workspace FileSystemProvider). With a revision: that
 * commit vs its parent, both sides via readFileAtRevision. Absent sides
 * render as empty text with an "(absent)" label; binary files short-circuit
 * to a hint since there is no text diff to show.
 */

import { useEffect, useState } from 'react';
import { getFileSystemProviderV2, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { Dialog } from '../components/Dialog.js';
import { useGitContext } from './GitContext.js';
import { GitDiffView } from './GitDiffView.js';

export interface GitDiffDialogProps {
  /** Slash-prefixed workspace-relative path. */
  path: string;
  /** Absent → working tree vs HEAD; present → that commit vs its parent. */
  revision?: { sha: string };
  onClose: () => void;
}

type DiffLoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'binary' }
  | {
      phase: 'ready';
      original: string;
      modified: string;
      labels: { original: string; modified: string };
    };

export function GitDiffDialog({ path, revision, onClose }: GitDiffDialogProps) {
  const git = useGitContext();
  const gitApi = git?.gitApi ?? null;
  const provider = git?.provider ?? null;
  const repositoryId = git?.repositoryId ?? null;
  const sha = revision?.sha ?? null;

  const [state, setState] = useState<DiffLoadState>({ phase: 'loading' });

  useEffect(() => {
    if (!gitApi || !repositoryId) {
      setState({ phase: 'error', message: 'Git is not available for this workspace.' });
      return;
    }
    let cancelled = false;
    setState({ phase: 'loading' });

    const load = async (): Promise<DiffLoadState> => {
      if (sha) {
        const short = sha.slice(0, 7);
        const [parent, at] = await Promise.all([
          gitApi.readFileAtRevision(repositoryId, path, { kind: 'parent-of', sha }),
          gitApi.readFileAtRevision(repositoryId, path, { kind: 'commit', sha }),
        ]);
        if (!parent.ok) return { phase: 'error', message: parent.error.message };
        if (!at.ok) return { phase: 'error', message: at.error.message };
        if (
          (parent.value.content === null && parent.value.binary) ||
          (at.value.content === null && at.value.binary)
        ) {
          return { phase: 'binary' };
        }
        return {
          phase: 'ready',
          original: parent.value.content ?? '',
          modified: at.value.content ?? '',
          labels: {
            original: parent.value.content === null ? `${short}^ (absent)` : `${short}^`,
            modified: at.value.content === null ? `${short} (absent)` : short,
          },
        };
      }

      if (!provider) {
        return { phase: 'error', message: 'Workspace files are not available.' };
      }
      const providerV2 = getFileSystemProviderV2(provider);
      const [head, working] = await Promise.all([
        gitApi.readFileAtRevision(repositoryId, path, { kind: 'head' }),
        providerV2
          ? providerV2
              .readFile(parseWorkspacePath(path))
              .then((file) => (file ? new TextDecoder().decode(file.data) : null))
          : provider.readFile(path),
      ]);
      if (!head.ok) return { phase: 'error', message: head.error.message };
      if (head.value.content === null && head.value.binary) return { phase: 'binary' };
      return {
        phase: 'ready',
        original: head.value.content ?? '',
        modified: working ?? '',
        labels: {
          original: head.value.content === null ? 'HEAD (absent)' : 'HEAD',
          modified: working === null ? 'Working tree (absent)' : 'Working tree',
        },
      };
    };

    load()
      .catch(
        (err: unknown): DiffLoadState => ({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Failed to load the diff',
        }),
      )
      .then((next) => {
        if (!cancelled) setState(next);
      });
    return () => {
      cancelled = true;
    };
  }, [gitApi, provider, repositoryId, path, sha]);

  if (!git) return null;

  const fullPath = path.replace(/^\/+/, '');
  const baseName = fullPath.split('/').pop() || fullPath;

  return (
    <Dialog title={baseName} size="full" onClose={onClose}>
      <p className="db-settings-hint">{fullPath}</p>
      {state.phase === 'loading' && <p className="db-git-hint">Loading changes…</p>}
      {state.phase === 'error' && (
        <p className="db-git-form-error" role="alert">
          {state.message}
        </p>
      )}
      {state.phase === 'binary' && (
        <p className="db-git-hint">Binary file — no text diff available.</p>
      )}
      {state.phase === 'ready' && (
        <GitDiffView
          original={state.original}
          modified={state.modified}
          fileName={baseName}
          theme={git.theme}
          labels={state.labels}
        />
      )}
    </Dialog>
  );
}
