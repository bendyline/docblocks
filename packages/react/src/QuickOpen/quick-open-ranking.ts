/**
 * Quick-open ranking: fuzzy relevance first, nudged by what the user opened
 * recently and pinned. A clearly better name match always wins over recency.
 */

import type { IndexedDocument, WorkspaceIndexFile } from '@bendyline/docblocks/workspace-index';
import { fuzzyMatch, fuzzyTokens } from '@bendyline/docblocks/workspace-index';
import { displayFileName } from '../FileExplorer/file-names.js';

export type QuickOpenRange = readonly [number, number];

export interface QuickOpenPin {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly path: string;
}

export interface QuickOpenItem {
  readonly key: string;
  readonly workspaceId: string;
  /** Set for documents in another workspace (pins), shown beside the folder. */
  readonly workspaceName: string | null;
  readonly path: string;
  /** Name as the explorer shows it (Markdown without `.md`). */
  readonly name: string;
  readonly folder: string;
  /** Document title, when it says more than the file name. */
  readonly title: string | null;
  readonly nameRanges: readonly QuickOpenRange[];
  readonly folderRanges: readonly QuickOpenRange[];
  readonly titleRanges: readonly QuickOpenRange[];
  readonly recent: boolean;
  readonly pinned: boolean;
}

export interface QuickOpenInput {
  readonly query: string;
  readonly workspaceId: string;
  readonly files: readonly WorkspaceIndexFile[];
  readonly documents: readonly IndexedDocument[];
  /** Current workspace, most recent first. */
  readonly recent: readonly string[];
  readonly pins: readonly QuickOpenPin[];
  readonly activePath: string | null;
  readonly limit?: number;
}

interface Candidate {
  readonly workspaceId: string;
  readonly workspaceName: string | null;
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  readonly title: string | null;
  readonly isDocument: boolean;
  readonly recentRank: number;
  readonly pinned: boolean;
}

const DEFAULT_LIMIT = 50;
const EMPTY_QUERY_LIMIT = 20;
const RECENCY_HORIZON = 50;
const RECENCY_WEIGHT = 0.25;
const PINNED_WEIGHT = 0.05;
const DOCUMENT_WEIGHT = 0.03;

function splitPath(path: string): { folder: string; base: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { folder: '', base: path }
    : { folder: path.slice(0, slash), base: path.slice(slash + 1) };
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function item(
  candidate: Candidate,
  ranges?: Partial<Pick<QuickOpenItem, 'nameRanges' | 'folderRanges' | 'titleRanges'>>,
): QuickOpenItem {
  return {
    key: `${candidate.workspaceId}\0${candidate.path}`,
    workspaceId: candidate.workspaceId,
    workspaceName: candidate.workspaceName,
    path: candidate.path,
    name: candidate.name,
    folder: candidate.folder,
    title: candidate.title,
    nameRanges: ranges?.nameRanges ?? [],
    folderRanges: ranges?.folderRanges ?? [],
    titleRanges: ranges?.titleRanges ?? [],
    recent: candidate.recentRank >= 0,
    pinned: candidate.pinned,
  };
}

function buildCandidates(input: QuickOpenInput): Candidate[] {
  const titles = new Map(
    input.documents.map((document) => [document.path as string, document.title]),
  );
  const recentRank = new Map(input.recent.map((path, rank) => [path, rank]));
  const pinnedHere = new Set(
    input.pins.filter((pin) => pin.workspaceId === input.workspaceId).map((pin) => pin.path),
  );
  const candidates: Candidate[] = input.files.map((file) => {
    const { folder } = splitPath(file.path);
    const name = displayFileName(file.name);
    const title = titles.get(file.path) ?? null;
    return {
      workspaceId: input.workspaceId,
      workspaceName: null,
      path: file.path,
      name,
      folder,
      title: title && title !== stemOf(file.name) && title !== name ? title : null,
      isDocument: file.kind !== 'other',
      recentRank: recentRank.get(file.path) ?? -1,
      pinned: pinnedHere.has(file.path),
    };
  });
  for (const pin of input.pins) {
    if (pin.workspaceId === input.workspaceId) continue;
    const { folder, base } = splitPath(pin.path);
    candidates.push({
      workspaceId: pin.workspaceId,
      workspaceName: pin.workspaceName,
      path: pin.path,
      name: displayFileName(base),
      folder,
      title: null,
      isDocument: true,
      recentRank: -1,
      pinned: true,
    });
  }
  return candidates;
}

/** Recently opened, then pins, then recently modified: what to show before typing. */
function emptyQuery(input: QuickOpenInput, candidates: readonly Candidate[]): QuickOpenItem[] {
  const byPath = new Map(
    candidates
      .filter((candidate) => candidate.workspaceId === input.workspaceId)
      .map((candidate) => [candidate.path, candidate]),
  );
  const shown = new Set<string>();
  const items: QuickOpenItem[] = [];
  const add = (candidate: Candidate | undefined) => {
    if (!candidate) return;
    const key = `${candidate.workspaceId}\0${candidate.path}`;
    const active =
      candidate.workspaceId === input.workspaceId && candidate.path === input.activePath;
    if (shown.has(key) || active) return;
    shown.add(key);
    items.push(item(candidate));
  };
  for (const path of input.recent) add(byPath.get(path));
  for (const candidate of candidates) if (candidate.pinned) add(candidate);
  const lastModified = new Map(input.files.map((file) => [file.path as string, file.lastModified]));
  const modified = [...byPath.values()].sort(
    (left, right) =>
      compareCodeUnits(lastModified.get(right.path) ?? '', lastModified.get(left.path) ?? '') ||
      compareCodeUnits(left.path, right.path),
  );
  for (const candidate of modified) {
    if (items.length >= EMPTY_QUERY_LIMIT) break;
    add(candidate);
  }
  return items;
}

interface FieldMatch {
  readonly score: number;
  readonly field: 'name' | 'title' | 'folder' | 'path';
  readonly ranges: readonly QuickOpenRange[];
}

const FIELD_WEIGHTS = { name: 1, title: 0.9, folder: 0.6, path: 1 } as const;

function bestField(token: string, candidate: Candidate): FieldMatch | null {
  const fields: [FieldMatch['field'], string | null][] = token.includes('/')
    ? [['path', candidate.folder ? `${candidate.folder}/${candidate.name}` : candidate.name]]
    : [
        ['name', candidate.name],
        ['title', candidate.title],
        ['folder', candidate.folder],
      ];
  let best: FieldMatch | null = null;
  for (const [field, text] of fields) {
    if (!text) continue;
    const match = fuzzyMatch(token, text);
    if (!match) continue;
    const score = match.score * FIELD_WEIGHTS[field];
    if (!best || score > best.score) best = { score, field, ranges: match.ranges };
  }
  return best;
}

function mergeRanges(ranges: readonly QuickOpenRange[]): QuickOpenRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Ranked quick-open results for `input.query`. */
export function rankQuickOpen(input: QuickOpenInput): QuickOpenItem[] {
  const candidates = buildCandidates(input);
  const tokens = fuzzyTokens(input.query);
  if (tokens.length === 0) return emptyQuery(input, candidates);

  const perfect = tokens.reduce(
    (total, token) => total + (fuzzyMatch(token, token)?.score ?? 0),
    0,
  );
  const scored: { readonly item: QuickOpenItem; readonly score: number }[] = [];
  for (const candidate of candidates) {
    let score = 0;
    const ranges = {
      name: [] as QuickOpenRange[],
      title: [] as QuickOpenRange[],
      folder: [] as QuickOpenRange[],
    };
    let matched = true;
    for (const token of tokens) {
      const best = bestField(token, candidate);
      if (!best) {
        matched = false;
        break;
      }
      score += best.score;
      if (best.field === 'path') {
        // Split a full-path match across the folder and name columns.
        const offset = candidate.folder ? candidate.folder.length + 1 : 0;
        for (const [start, end] of best.ranges) {
          if (end <= candidate.folder.length) ranges.folder.push([start, end]);
          else if (start >= offset) ranges.name.push([start - offset, end - offset]);
          else {
            ranges.folder.push([start, candidate.folder.length]);
            ranges.name.push([0, end - offset]);
          }
        }
      } else {
        ranges[best.field].push(...best.ranges);
      }
    }
    if (!matched) continue;
    if (candidate.recentRank >= 0 && candidate.recentRank < RECENCY_HORIZON) {
      score += perfect * RECENCY_WEIGHT * (1 - candidate.recentRank / RECENCY_HORIZON);
    }
    if (candidate.pinned) score += perfect * PINNED_WEIGHT;
    if (candidate.isDocument) score += perfect * DOCUMENT_WEIGHT;
    scored.push({
      score,
      item: item(candidate, {
        nameRanges: mergeRanges(ranges.name),
        titleRanges: mergeRanges(ranges.title),
        folderRanges: mergeRanges(ranges.folder),
      }),
    });
  }
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.item.path.length - right.item.path.length ||
      compareCodeUnits(left.item.path, right.item.path),
  );
  return scored.slice(0, input.limit ?? DEFAULT_LIMIT).map((entry) => entry.item);
}
