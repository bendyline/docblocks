/**
 * The state behind Ask's suggestions: per conversation, the proposals for
 * each answer and whether edits are allowed. Kept per session rather than in
 * a component, so they survive the panel remounting when a note opens.
 */

import { parseWorkspacePassageUri } from '@bendyline/docblocks/host';

import { citationParts } from './knowledge-citations.js';
import {
  isEdit,
  type ActionTarget,
  type AppliedAction,
  type ProposedAction,
} from './chat-actions.js';
import type { AskTurn, WorkspaceAskSession } from './workspace-ask.js';

/** What the shell does with a confirmed action. */
export interface AskActions {
  /**
   * The open workspace's catalog id (`workspaceCatalogId`): only its notes can
   * be edited. A conversation outlives switching workspaces, and a note cited
   * from the one before is not here to change.
   */
  readonly catalogId?: string;
  /** Carry it out; null when it did not happen (the shell has already said why). */
  run(action: ProposedAction): Promise<AppliedAction | null>;
  /** Open a document an action created or changed. */
  open(path: string): void;
}

export type EntryState = 'offered' | 'running' | 'done' | 'skipped' | 'failed';

export interface ProposalEntry {
  readonly action: ProposedAction;
  readonly state: EntryState;
  readonly path: string | null;
  readonly versionKept: boolean;
}

export type TurnProposals =
  | { readonly status: 'thinking'; readonly controller: AbortController }
  | { readonly status: 'ready'; readonly entries: readonly ProposalEntry[] }
  | { readonly status: 'none' }
  | { readonly status: 'error'; readonly message: string };

export interface ProposalSnapshot {
  readonly allowEdits: boolean;
  readonly turns: ReadonlyMap<number, TurnProposals>;
}

export interface ProposalStore {
  getSnapshot(): ProposalSnapshot;
  subscribe(listener: () => void): () => void;
  setAllowEdits(allow: boolean): void;
  set(turnId: number, proposals: TurnProposals | null): void;
  /** Change one card, if the turn's proposals are still the ones it was made from. */
  updateEntry(turnId: number, index: number, change: Partial<ProposalEntry>): void;
  /**
   * Start one card: only one that is offered, or failed and being tried
   * again, and an edit only while edits are allowed. Marks it running and
   * returns its action, or null when it may not run now (skipped, done, or
   * already running from another click or "Do all").
   */
  claim(turnId: number, index: number): ProposedAction | null;
  reset(): void;
}

export function createProposalStore(): ProposalStore {
  let snapshot: ProposalSnapshot = { allowEdits: false, turns: new Map() };
  const listeners = new Set<() => void>();
  const publish = (next: ProposalSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const updateEntry = (turnId: number, index: number, change: Partial<ProposalEntry>) => {
    const current = snapshot.turns.get(turnId);
    if (current?.status !== 'ready' || !current.entries[index]) return;
    const entries = current.entries.map((entry, at) =>
      at === index ? { ...entry, ...change } : entry,
    );
    const turns = new Map(snapshot.turns);
    turns.set(turnId, { status: 'ready', entries });
    publish({ ...snapshot, turns });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAllowEdits(allow) {
      if (allow !== snapshot.allowEdits) publish({ ...snapshot, allowEdits: allow });
    },
    set(turnId, proposals) {
      const turns = new Map(snapshot.turns);
      if (proposals) turns.set(turnId, proposals);
      else turns.delete(turnId);
      publish({ ...snapshot, turns });
    },
    updateEntry,
    claim(turnId, index) {
      // Checked and marked in one synchronous step, so two callers cannot both start it.
      const current = snapshot.turns.get(turnId);
      const entry = current?.status === 'ready' ? current.entries[index] : undefined;
      if (!entry || (entry.state !== 'offered' && entry.state !== 'failed')) return null;
      if (isEdit(entry.action) && !snapshot.allowEdits) return null;
      updateEntry(turnId, index, { state: 'running' });
      return entry.action;
    },
    reset() {
      for (const proposals of snapshot.turns.values()) {
        if (proposals.status === 'thinking') proposals.controller.abort();
      }
      publish({ allowEdits: false, turns: new Map() });
    },
  };
}

const stores = new WeakMap<WorkspaceAskSession, ProposalStore>();

export function proposalStoreFor(session: WorkspaceAskSession): ProposalStore {
  let store = stores.get(session);
  if (!store) {
    store = createProposalStore();
    stores.set(session, store);
  }
  return store;
}

/** Forget a conversation's proposals; a new conversation starts without edits allowed. */
export function resetAskProposals(session: WorkspaceAskSession): void {
  stores.get(session)?.reset();
}

const MARKDOWN = /\.(?:md|markdown|mdown)$/i;

/**
 * The documents a turn cited that an edit could target: the person's own
 * Markdown notes behind the passages the answer marks with `[n]`. An answer
 * with no markers at all (some models do not cite) offers the passages it
 * was given, which are the sources shown under it. With `catalogId`, only
 * notes from that workspace.
 */
export function citedTargets(turn: AskTurn, catalogId?: string): ActionTarget[] {
  if (turn.knowledge?.outcome !== 'used') return [];
  const cited = new Set<number>();
  for (const part of citationParts(turn.answer)) {
    if (typeof part !== 'string') for (const number of part) cited.add(number - 1);
  }
  const targets = new Map<string, ActionTarget>();
  for (const [index, passage] of turn.knowledge.evidence.entries()) {
    if (cited.size > 0 && !cited.has(index)) continue;
    // No catalog may publish under knowledge://local/, so the reference alone
    // says a passage is one of the person's notes (ai-workspace-knowledge.ts).
    const reference = passage.uri ? parseWorkspacePassageUri(passage.uri) : null;
    if (!reference || !MARKDOWN.test(reference.path) || targets.has(reference.path)) continue;
    if (catalogId !== undefined && reference.catalogId !== catalogId) continue;
    targets.set(reference.path, { path: reference.path, title: passage.title || reference.path });
  }
  return [...targets.values()];
}
