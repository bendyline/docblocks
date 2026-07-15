/**
 * GitHistoryDialog — paged commit log for the repository or a single file.
 *
 * Pages `git log` 50 commits at a time; a row expands (one at a time) to
 * show the full message body and the files changed in that commit — each
 * file opens the commit-vs-parent diff dialog (which replaces this one;
 * acceptable for v1).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitFileChange, GitLogEntry } from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';
import { useGitContext } from './GitContext.js';
import { BADGE_GLYPHS, BADGE_LABELS, badgeKindFor } from './git-status.js';

export interface GitHistoryDialogProps {
  /** Slash-prefixed workspace-relative path; absent → whole-repo history. */
  path?: string;
  onClose: () => void;
}

const PAGE_SIZE = 50;

type CommitDetail = { body: string; files: GitFileChange[] } | { error: string };

/** Message body beyond the subject line, or '' when it adds nothing. */
function extraBody(body: string, subject: string): string {
  const trimmedBody = body.trim();
  const trimmedSubject = subject.trim();
  if (!trimmedBody || trimmedBody === trimmedSubject) return '';
  if (trimmedBody.startsWith(trimmedSubject)) {
    return trimmedBody.slice(trimmedSubject.length).trim();
  }
  return trimmedBody;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

export function GitHistoryDialog({ path, onClose }: GitHistoryDialogProps) {
  const git = useGitContext();
  const gitApi = git?.gitApi ?? null;
  const repositoryId = git?.repositoryId ?? null;

  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [details, setDetails] = useState<ReadonlyMap<string, CommitDetail>>(new Map());
  /**
   * Bumped whenever the repository or file being logged changes. A slow
   * page from the previous repo/file resolving afterwards would otherwise
   * append the wrong repository's commits to the new list.
   */
  const generationRef = useRef(0);

  const loadPage = useCallback(
    async (skip: number) => {
      if (!gitApi || !repositoryId) return;
      const generation = generationRef.current;
      const stale = () => generation !== generationRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await gitApi.log(repositoryId, { path, maxCount: PAGE_SIZE, skip });
        if (stale()) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setEntries((prev) => (skip === 0 ? result.value : [...prev, ...result.value]));
        setHasMore(result.value.length === PAGE_SIZE);
      } catch (caught: unknown) {
        // A rejected log left the dialog claiming "No commits yet".
        if (stale()) return;
        setError(caught instanceof Error ? caught.message : 'Could not load history');
      } finally {
        if (!stale()) setLoading(false);
      }
    },
    [gitApi, repositoryId, path],
  );

  useEffect(() => {
    generationRef.current += 1;
    setEntries([]);
    setExpandedSha(null);
    setDetails(new Map());
    setHasMore(false);
    setLoading(false);
    void loadPage(0);
  }, [loadPage]);

  const handleRowClick = (sha: string) => {
    if (expandedSha === sha) {
      setExpandedSha(null);
      return;
    }
    setExpandedSha(sha);
    if (!gitApi || !repositoryId || details.has(sha)) return;
    const generation = generationRef.current;
    const record = (detail: CommitDetail) => {
      // The row renders "Loading…" until a detail lands, so a rejection
      // that recorded nothing left it spinning for the dialog's lifetime.
      if (generation !== generationRef.current) return;
      setDetails((prev) => {
        const next = new Map(prev);
        next.set(sha, detail);
        return next;
      });
    };
    void gitApi.commitFiles(repositoryId, sha).then(
      (result) => record(result.ok ? result.value : { error: result.error.message }),
      (error: unknown) =>
        record({
          error: error instanceof Error ? error.message : 'Could not load this commit',
        }),
    );
  };

  if (!git) return null;

  const baseName = path ? path.replace(/^\/+/, '').split('/').pop() : null;
  const title = baseName ? `History — ${baseName}` : 'Commit history';

  return (
    <Dialog title={title} size="wide" onClose={onClose}>
      {error && (
        <p className="db-git-form-error" role="alert">
          {error}
        </p>
      )}
      {!error && entries.length === 0 && loading && <p className="db-git-hint">Loading history…</p>}
      {!error && entries.length === 0 && !loading && <p className="db-git-hint">No commits yet.</p>}
      {entries.length > 0 && (
        <ul className="db-git-history-list">
          {entries.map((entry) => {
            const expanded = expandedSha === entry.sha;
            const detail = details.get(entry.sha);
            const meta = [
              entry.authorName,
              entry.sha.slice(0, 7),
              formatDate(entry.authorDate),
              entry.refs.join(', '),
            ]
              .filter(Boolean)
              .join(' · ');
            const body =
              detail && !('error' in detail) ? extraBody(detail.body, entry.subject) : '';
            return (
              <li key={entry.sha} className="db-git-history-item">
                <button
                  type="button"
                  className="db-git-history-toggle"
                  aria-expanded={expanded}
                  onClick={() => handleRowClick(entry.sha)}
                >
                  <span className="db-git-history-subject">{entry.subject}</span>
                  <span className="db-git-history-meta">{meta}</span>
                </button>
                {expanded && !detail && <p className="db-git-hint">Loading…</p>}
                {expanded && detail && 'error' in detail && (
                  <p className="db-git-form-error" role="alert">
                    {detail.error}
                  </p>
                )}
                {expanded && detail && !('error' in detail) && (
                  <>
                    {body && <pre className="db-git-history-body">{body}</pre>}
                    <ul className="db-git-history-files">
                      {detail.files.map((file) => {
                        const kind = badgeKindFor(file);
                        return (
                          <li key={file.path}>
                            <button
                              type="button"
                              className="db-git-history-file"
                              onClick={() =>
                                git.openDialog({
                                  kind: 'diff',
                                  path: file.path,
                                  revision: { sha: entry.sha },
                                })
                              }
                            >
                              <span
                                className="db-git-file-kind"
                                aria-label={BADGE_LABELS[kind]}
                                title={BADGE_LABELS[kind]}
                              >
                                {BADGE_GLYPHS[kind]}
                              </span>
                              {file.path.replace(/^\/+/, '')}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <button
          type="button"
          className="db-git-secondary-btn"
          disabled={loading}
          onClick={() => void loadPage(entries.length)}
        >
          Show older commits
        </button>
      )}
    </Dialog>
  );
}
