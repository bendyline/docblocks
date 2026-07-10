/**
 * Repo state watcher — observes the parts of the git dir that change when
 * repository state changes (HEAD, index, refs, in-progress operations),
 * ignoring transient *.lock files so our own and other tools' operations
 * don't cause feedback churn. Worktree edits are NOT covered here — the
 * caller pairs this with the workspace watcher for those.
 */

import path from 'node:path';
import chokidar from 'chokidar';

export interface RepoWatcherOptions {
  /** Absolute per-worktree git dir (HEAD, index, MERGE_HEAD…). */
  gitDir: string;
  /** Absolute common git dir (refs/, packed-refs, FETCH_HEAD). */
  commonDir: string;
  onChange: () => void;
}

export interface RepoWatcher {
  close(): Promise<void>;
}

export function createRepoWatcher(opts: RepoWatcherOptions): RepoWatcher {
  const targets = [
    path.join(opts.gitDir, 'HEAD'),
    path.join(opts.gitDir, 'index'),
    path.join(opts.gitDir, 'MERGE_HEAD'),
    path.join(opts.gitDir, 'CHERRY_PICK_HEAD'),
    path.join(opts.gitDir, 'REVERT_HEAD'),
    path.join(opts.gitDir, 'BISECT_LOG'),
    path.join(opts.gitDir, 'rebase-merge'),
    path.join(opts.gitDir, 'rebase-apply'),
    path.join(opts.commonDir, 'packed-refs'),
    path.join(opts.commonDir, 'FETCH_HEAD'),
    path.join(opts.commonDir, 'refs'),
  ];
  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    ignored: (candidate: string) => candidate.endsWith('.lock'),
    depth: 6,
  });
  const notify = () => opts.onChange();
  watcher.on('add', notify);
  watcher.on('change', notify);
  watcher.on('unlink', notify);
  watcher.on('addDir', notify);
  watcher.on('unlinkDir', notify);
  return {
    close: () => watcher.close().catch(() => undefined),
  };
}
