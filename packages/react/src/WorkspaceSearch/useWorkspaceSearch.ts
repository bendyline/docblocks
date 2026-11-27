import { useEffect, useRef, useState } from 'react';
import type {
  WorkspaceIndex,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
} from '@bendyline/docblocks/workspace-index';
import {
  RANKED_PASSAGE_LIMIT,
  RANKED_PASSAGES_PER_DOCUMENT,
  rankedSearchResult,
} from './ranked-results.js';

export interface WorkspaceSearchState {
  readonly result: WorkspaceSearchResult | null;
  /** A search for the current query has not reported yet. */
  readonly searching: boolean;
}

const EMPTY: WorkspaceSearchState = { result: null, searching: false };
const QUERY_DEBOUNCE_MS = 200;
/** Throttle, not debounce: the index publishes every 250 ms while analyzing. */
const INDEX_REFRESH_MS = 750;

/** `literal` finds the exact text; `ranked` finds the best passages for the words. */
export type WorkspaceSearchMode = 'literal' | 'ranked';

/**
 * Run a workspace search for `query`, debounced while typing, and re-run it
 * as the index fills in or changes so open results stay current.
 */
export function useWorkspaceSearch(
  index: WorkspaceIndex | null,
  generation: number,
  query: WorkspaceSearchQuery,
  mode: WorkspaceSearchMode = 'literal',
): WorkspaceSearchState {
  const [state, setState] = useState<WorkspaceSearchState>(EMPTY);
  const controllerRef = useRef<AbortController | null>(null);
  const runRef = useRef<(() => void) | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { text } = query;
  const matchCase = query.matchCase ?? false;
  const wholeWord = query.wholeWord ?? false;

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (!index || !text.trim()) {
      runRef.current = null;
      setState(EMPTY);
      return;
    }
    const run = () => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const search: Promise<WorkspaceSearchResult> =
        mode === 'ranked' && index.find
          ? index
              .find(text, {
                limit: RANKED_PASSAGE_LIMIT,
                perDocument: RANKED_PASSAGES_PER_DOCUMENT,
                prefix: true,
              })
              .then((hits) => rankedSearchResult(hits, (path) => index.getDocument(path)))
          : index.search({ text, matchCase, wholeWord }, { signal: controller.signal });
      search.then(
        (result) => {
          if (controllerRef.current === controller) setState({ result, searching: false });
        },
        () => {
          if (controllerRef.current === controller) {
            setState((current) => ({ ...current, searching: false }));
          }
        },
      );
    };
    runRef.current = run;
    // A row's open request uses the current query and workspace. Keeping the
    // previous result here lets it open an unrelated path during the debounce.
    setState({ result: null, searching: true });
    const timer = setTimeout(run, QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [index, text, matchCase, wholeWord, mode]);

  useEffect(() => {
    if (!runRef.current || refreshTimerRef.current !== null) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      runRef.current?.();
    }, INDEX_REFRESH_MS);
  }, [generation]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      runRef.current = null;
      if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
    },
    [],
  );

  return state;
}
