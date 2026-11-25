/**
 * What Home needs to know about a workspace that is not open: its tasks and
 * dated documents, its kind folders, and how much waits in Unfiled. Projected
 * from a workspace's index whenever it is open, kept on this device, and shown
 * "as of" when it was made for workspaces that are not.
 *
 * Stored digests are parsed as `unknown` with the exact shape and bounded
 * sizes; anything else is a cache miss, never an error.
 */

import type { FolderKind, KindFolder } from '@bendyline/docblocks/folders';
import {
  daysBetween,
  isLocalDate,
  normalizeDue,
  type LocalDate,
  type RepeatRule,
} from '@bendyline/docblocks/properties';
import type { IndexedDocument } from '@bendyline/docblocks/workspace-index';
import type { TaskItem } from '../Tasks/task-model.js';

export const HOME_DIGEST_FORMAT = 1;

export const HOME_DIGEST_LIMITS = {
  maxItems: 3_000,
  maxFolders: 256,
  maxText: 512,
  /** Finished tasks kept, by how recently. */
  doneDays: 30,
} as const;

export interface DigestFolder {
  readonly path: string;
  readonly kind: FolderKind;
  /** Documents waiting, for an Unfiled drawer. */
  readonly waiting?: number;
}

export interface HomeDigest {
  readonly format: typeof HOME_DIGEST_FORMAT;
  readonly workspaceId: string;
  /** When it was made, as an ISO instant. */
  readonly madeAt: string;
  readonly folders: readonly DigestFolder[];
  readonly items: readonly TaskItem[];
  /** Items left out to stay within bounds. */
  readonly dropped: number;
}

const REPEATS: readonly RepeatRule[] = ['daily', 'weekly', 'monthly', 'yearly'];
const KINDS: readonly FolderKind[] = ['tasks', 'journal', 'unfiled'];

/** The digest of a workspace's current tasks and folders. */
export function projectHomeDigest(input: {
  readonly workspaceId: string;
  readonly kindFolders: readonly KindFolder[];
  readonly documents: readonly IndexedDocument[];
  readonly items: readonly TaskItem[];
  readonly today: LocalDate;
  readonly now: Date;
}): HomeDigest {
  const { workspaceId, kindFolders, documents, items, today, now } = input;
  const keep = items.filter((item) => {
    if (item.pending) return false;
    if (!item.done) return true;
    const when =
      item.completedOn ??
      (isLocalDate(item.lastModified.slice(0, 10)) ? item.lastModified.slice(0, 10) : null);
    return when !== null && daysBetween(when, today) <= HOME_DIGEST_LIMITS.doneDays;
  });
  // Open tasks first, so bounds drop finished ones before anything still to do.
  keep.sort((left, right) => Number(left.done) - Number(right.done));
  const kept = keep.slice(0, HOME_DIGEST_LIMITS.maxItems);
  const folders: DigestFolder[] = kindFolders
    // Home has nothing to show for Ask's chats, and older readers reject a kind they do not know.
    .filter((folder) => folder.settings.kind !== 'chats')
    .slice(0, HOME_DIGEST_LIMITS.maxFolders)
    .map((folder) => {
      const kind = folder.settings.kind;
      if (kind !== 'unfiled') return { path: folder.path, kind };
      const prefix = folder.path ? `${folder.path}/` : '';
      return {
        path: folder.path,
        kind,
        waiting: documents.filter((document) => document.path.startsWith(prefix)).length,
      };
    });
  return {
    format: HOME_DIGEST_FORMAT,
    workspaceId,
    madeAt: now.toISOString(),
    folders,
    items: kept.map((item) => ({ ...item, workspaceId, pending: false })),
    dropped: keep.length - kept.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > HOME_DIGEST_LIMITS.maxText) throw new Error();
  return value;
}

function parseItem(value: unknown, workspaceId: string): TaskItem {
  if (!isRecord(value)) throw new Error();
  const due = value.due === undefined ? undefined : normalizeDue(value.due);
  if (value.due !== undefined && !due) throw new Error();
  const repeat = value.repeat;
  if (repeat !== undefined && !REPEATS.includes(repeat as RepeatRule)) throw new Error();
  if (typeof value.done !== 'boolean') throw new Error();
  const completedOn = value.completedOn;
  if (completedOn !== undefined && !isLocalDate(completedOn)) throw new Error();
  const checklist = value.checklist;
  if (
    checklist !== undefined &&
    !(
      isRecord(checklist) &&
      Number.isInteger(checklist.done) &&
      Number.isInteger(checklist.total) &&
      (checklist.done as number) >= 0 &&
      (checklist.total as number) >= (checklist.done as number)
    )
  ) {
    throw new Error();
  }
  const tags = value.tags;
  if (
    tags !== undefined &&
    !(
      Array.isArray(tags) &&
      tags.length <= 32 &&
      tags.every((tag) => typeof tag === 'string' && tag.length <= 64)
    )
  ) {
    throw new Error();
  }
  const folder = value.folder === null ? null : text(value.folder);
  const bucket = value.bucket === null ? null : text(value.bucket);
  return {
    workspaceId,
    path: text(value.path) as never,
    title: text(value.title)!,
    ...(due ? { due } : {}),
    ...(value.category !== undefined ? { category: text(value.category)! } : {}),
    ...(tags !== undefined ? { tags: tags as string[] } : {}),
    ...(repeat !== undefined ? { repeat: repeat as RepeatRule } : {}),
    done: value.done,
    ...(completedOn !== undefined ? { completedOn: completedOn as LocalDate } : {}),
    ...(checklist !== undefined
      ? { checklist: { done: checklist.done as number, total: checklist.total as number } }
      : {}),
    folder: (folder ?? null) as TaskItem['folder'],
    bucket: bucket ?? null,
    group: text(value.group ?? '')!,
    pending: false,
    lastModified: text(value.lastModified)!,
  };
}

/** A stored digest, or null when it is not one this version wrote. */
export function parseHomeDigest(value: unknown, workspaceId: string): HomeDigest | null {
  try {
    if (!isRecord(value) || value.format !== HOME_DIGEST_FORMAT) return null;
    if (value.workspaceId !== workspaceId) return null;
    const madeAt = text(value.madeAt)!;
    if (!Number.isFinite(Date.parse(madeAt))) return null;
    if (!Array.isArray(value.items) || value.items.length > HOME_DIGEST_LIMITS.maxItems)
      return null;
    if (!Array.isArray(value.folders) || value.folders.length > HOME_DIGEST_LIMITS.maxFolders) {
      return null;
    }
    const folders = value.folders.map((folder): DigestFolder => {
      if (!isRecord(folder) || !KINDS.includes(folder.kind as FolderKind)) throw new Error();
      const waiting = folder.waiting;
      if (waiting !== undefined && !(Number.isInteger(waiting) && (waiting as number) >= 0)) {
        throw new Error();
      }
      return {
        path: text(folder.path)!,
        kind: folder.kind as FolderKind,
        ...(waiting !== undefined ? { waiting: waiting as number } : {}),
      };
    });
    const dropped = value.dropped;
    if (!(Number.isInteger(dropped) && (dropped as number) >= 0)) return null;
    return {
      format: HOME_DIGEST_FORMAT,
      workspaceId,
      madeAt,
      folders,
      items: value.items.map((item) => parseItem(item, workspaceId)),
      dropped: dropped as number,
    };
  } catch {
    return null;
  }
}

/** Whether two digests say the same thing (the time they were made aside). */
export function sameHomeDigest(left: HomeDigest | null, right: HomeDigest): boolean {
  if (!left) return false;
  return JSON.stringify({ ...left, madeAt: '' }) === JSON.stringify({ ...right, madeAt: '' });
}
