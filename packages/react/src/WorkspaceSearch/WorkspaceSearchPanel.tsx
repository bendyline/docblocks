/**
 * Sidebar workspace search: literal matches across every indexed document,
 * grouped by document with line snippets. Results stay visible while matches
 * are opened, and the panel keeps its state while the Files view is shown.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  WorkspaceIndex,
  WorkspaceIndexStatus,
  WorkspaceSearchDocument,
  WorkspaceSearchLineMatch,
  WorkspaceSearchResult,
} from '@bendyline/docblocks/workspace-index';
import { HighlightedText } from '../components/HighlightedText.js';
import { FilesIcon } from '../icons.js';
import { useWorkspaceSearch } from './useWorkspaceSearch.js';

export interface WorkspaceSearchOpenRequest {
  readonly path: string;
  /** The line chosen, or null when the document row itself was opened. */
  readonly match: WorkspaceSearchLineMatch | null;
  readonly query: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
}

export interface WorkspaceSearchPanelProps {
  readonly index: WorkspaceIndex | null;
  readonly status: WorkspaceIndexStatus;
  readonly hidden: boolean;
  /** Advances each time the search shortcut asks for the query field. */
  readonly focusRequest: number;
  readonly onOpen: (request: WorkspaceSearchOpenRequest) => void;
  readonly onShowFiles: () => void;
}

type Row =
  | {
      readonly kind: 'document';
      readonly key: string;
      readonly document: WorkspaceSearchDocument;
      readonly position: number;
    }
  | {
      readonly kind: 'line';
      readonly key: string;
      readonly document: WorkspaceSearchDocument;
      readonly match: WorkspaceSearchLineMatch;
      readonly position: number;
    };

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function statusText(
  index: WorkspaceIndex | null,
  status: WorkspaceIndexStatus,
  query: string,
  result: WorkspaceSearchResult | null,
  searching: boolean,
): string {
  if (!index) return 'Search is not available for this workspace.';
  if (status.error) return status.error;
  const indexing =
    status.pendingCount > 0
      ? ` Indexing ${status.documentCount - status.pendingCount} of ${status.documentCount}…`
      : '';
  if (!query.trim()) {
    return status.listed
      ? `Search ${plural(status.documentCount, 'document')}.${indexing}`
      : 'Listing workspace…';
  }
  if (!result) return searching ? 'Searching…' : '';
  if (result.totalDocuments === 0) return `No results.${indexing}`;
  const found = `${plural(result.totalMatches, 'result')} in ${plural(result.totalDocuments, 'document')}`;
  const shown =
    result.truncated && result.documents.length < result.totalDocuments
      ? ` (showing the first ${result.documents.length})`
      : result.truncated
        ? ' (more not counted)'
        : '';
  return `${found}${shown}.${indexing}`;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function WorkspaceSearchPanel({
  index,
  status,
  hidden,
  focusRequest,
  onOpen,
  onShowFiles,
}: WorkspaceSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [text, setText] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const query = useMemo(() => ({ text, matchCase, wholeWord }), [text, matchCase, wholeWord]);
  const { result, searching } = useWorkspaceSearch(index, status.generation, query);

  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  // A new query starts with every document expanded.
  useEffect(() => {
    setCollapsed(new Set());
  }, [text, matchCase, wholeWord]);

  const rows = useMemo<Row[]>(() => {
    const flat: Row[] = [];
    for (const [position, document] of (result?.documents ?? []).entries()) {
      flat.push({ kind: 'document', key: `d:${document.path}`, document, position });
      if (collapsed.has(document.path)) continue;
      document.matches.forEach((match, matchPosition) =>
        flat.push({
          kind: 'line',
          key: `l:${document.path}:${matchPosition}`,
          document,
          match,
          position: matchPosition,
        }),
      );
    }
    return flat;
  }, [result, collapsed]);

  const tabStop = rows.some((row) => row.key === focusedKey) ? focusedKey : (rows[0]?.key ?? null);

  const focusRow = (key: string) => {
    setFocusedKey(key);
    rowRefs.current.get(key)?.focus();
  };

  const open = (document: WorkspaceSearchDocument, match: WorkspaceSearchLineMatch | null) =>
    onOpen({ path: document.path, match, query: text, matchCase, wholeWord });

  const toggle = (path: string, expand?: boolean) =>
    setCollapsed((current) => {
      const next = new Set(current);
      const shouldExpand = expand ?? next.has(path);
      if (shouldExpand) next.delete(path);
      else next.add(path);
      return next;
    });

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const position = rows.findIndex((row) => row.key === tabStop);
    const row = rows[position];
    if (!row) return;
    const isExpandable = row.kind === 'document' && row.document.matches.length > 0;
    const expanded = row.kind === 'document' && !collapsed.has(row.document.path);
    switch (event.key) {
      case 'ArrowDown':
        if (position < rows.length - 1) focusRow(rows[position + 1]!.key);
        break;
      case 'ArrowUp':
        if (position > 0) focusRow(rows[position - 1]!.key);
        break;
      case 'Home':
        focusRow(rows[0]!.key);
        break;
      case 'End':
        focusRow(rows[rows.length - 1]!.key);
        break;
      case 'ArrowRight':
        if (isExpandable && !expanded) toggle(row.document.path, true);
        else if (isExpandable && rows[position + 1]) focusRow(rows[position + 1]!.key);
        break;
      case 'ArrowLeft':
        if (row.kind === 'line') focusRow(`d:${row.document.path}`);
        else if (isExpandable && expanded) toggle(row.document.path, false);
        break;
      case 'Enter':
      case ' ':
        open(row.document, row.kind === 'line' ? row.match : null);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const documentCount = result?.documents.length ?? 0;

  return (
    <section className="db-search-panel" hidden={hidden} aria-label="Search workspace">
      <div className="db-explorer-toolbar">
        <span className="db-explorer-title">Search</span>
        <div className="db-explorer-actions">
          <button
            type="button"
            className="db-explorer-btn"
            onClick={onShowFiles}
            title="Show files"
            aria-label="Show files"
          >
            <FilesIcon />
          </button>
        </div>
      </div>
      <div className="db-search-form" role="search">
        <input
          ref={inputRef}
          className="db-search-input"
          type="search"
          aria-label="Search workspace"
          placeholder="Search"
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && rows[0]) {
              event.preventDefault();
              focusRow(rows[0].key);
            }
          }}
        />
        <button
          type="button"
          className="db-search-toggle"
          aria-pressed={matchCase}
          aria-label="Match case"
          title="Match case"
          onClick={() => setMatchCase((value) => !value)}
        >
          Aa
        </button>
        <button
          type="button"
          className="db-search-toggle db-search-toggle--word"
          aria-pressed={wholeWord}
          aria-label="Match whole word"
          title="Match whole word"
          onClick={() => setWholeWord((value) => !value)}
        >
          ab
        </button>
      </div>
      <p className="db-search-status" role="status">
        {statusText(index, status, text, result, searching)}
      </p>
      <div
        className="db-search-results"
        role="tree"
        aria-label="Search results"
        onKeyDown={onTreeKeyDown}
      >
        {rows.map((row) => {
          const common = {
            ref: (element: HTMLDivElement | null) => {
              if (element) rowRefs.current.set(row.key, element);
              else rowRefs.current.delete(row.key);
            },
            role: 'treeitem',
            tabIndex: row.key === tabStop ? 0 : -1,
            onFocus: () => setFocusedKey(row.key),
          } as const;
          if (row.kind === 'document') {
            const { document } = row;
            const expandable = document.matches.length > 0;
            const expanded = expandable && !collapsed.has(document.path);
            return (
              <div
                key={row.key}
                {...common}
                className="db-search-document"
                aria-level={1}
                aria-setsize={documentCount}
                aria-posinset={row.position + 1}
                aria-expanded={expandable ? expanded : undefined}
                onClick={() => open(document, null)}
              >
                <span
                  className="db-search-chevron"
                  aria-hidden="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (expandable) toggle(document.path);
                  }}
                >
                  {expandable ? (expanded ? '▾' : '▸') : ''}
                </span>
                <span className="db-search-document-title">
                  <HighlightedText text={document.title} ranges={document.titleRanges} />
                </span>
                <span className="db-search-document-path">{folderOf(document.path)}</span>
                {document.matchCount > 0 && (
                  <span
                    className="db-search-count"
                    aria-label={plural(document.matchCount, 'match')}
                  >
                    {document.matchCount}
                  </span>
                )}
              </div>
            );
          }
          const { match, document } = row;
          return (
            <div
              key={row.key}
              {...common}
              className="db-search-line"
              aria-level={2}
              aria-setsize={document.matches.length}
              aria-posinset={row.position + 1}
              onClick={() => open(document, match)}
            >
              <span className="db-search-line-number">{match.line}</span>
              <span className="db-search-snippet">
                <HighlightedText text={match.snippet} ranges={match.ranges} />
              </span>
            </div>
          );
        })}
      </div>
      {(result?.documents ?? []).some((document) => document.moreMatches) && (
        <p className="db-search-more">Some documents have more matches; open them to see all.</p>
      )}
    </section>
  );
}
