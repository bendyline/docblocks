/**
 * The workspace folder picker's tree, as pure decisions: which rows show, in
 * what order, at what depth, for a set of workspaces, the folders each has,
 * what is expanded and what the person typed to find a folder.
 *
 * Every workspace is a root, and choosing it means its top. Rows are keyed by
 * workspace and folder together (`folderKey`), so the same folder path in two
 * workspaces never collides, and the keys can drive the file tree's own
 * keyboard rules (`treeKeyAction`) unchanged.
 */

import { isDestinationFolderName } from '@bendyline/docblocks/filesystem';
import type { FolderKind } from '@bendyline/docblocks/folders';
import type { TreeRow } from '../FileExplorer/tree-keyboard.js';

export interface PickerWorkspace {
  readonly id: string;
  readonly name: string;
}

export interface PickerFolder {
  /** Workspace-relative, without a leading slash. */
  readonly path: string;
  /** What the folder says it is for, when it says. */
  readonly kind?: FolderKind | null;
}

/** A workspace's folders, or why they cannot be shown. */
export type WorkspaceFolders =
  | {
      readonly status: 'ready';
      readonly folders: readonly PickerFolder[];
      /** Not every folder could be listed in time; the ones shown are real. */
      readonly partial?: boolean;
    }
  | { readonly status: 'unavailable'; readonly message: string };

/** Where the person chose to put something. */
export interface FolderChoice {
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** Workspace-relative; `''` for the top of the workspace. */
  readonly path: string;
}

/**
 * Where a picker finds its workspaces and their folders. The first workspace
 * is listed first and starts open: the one the person is working in.
 */
export interface WorkspaceFolderSource {
  readonly workspaces: readonly PickerWorkspace[];
  /**
   * Every folder of a workspace (not its top), answered at once where they
   * are already known, as the open workspace's index knows them. Never
   * rejects: a workspace that cannot be read answers `unavailable`.
   */
  listFolders(workspaceId: string): WorkspaceFolders | Promise<WorkspaceFolders>;
}

/** A workspace's folders as the picker holds them: not asked yet, being read, or answered. */
export type FolderListing = WorkspaceFolders | { readonly status: 'loading' };

export interface PickerRow extends TreeRow {
  readonly workspaceId: string;
  /** Workspace-relative; `''` for the workspace itself. */
  readonly folderPath: string;
  readonly name: string;
  readonly isWorkspace: boolean;
  readonly folderKind: FolderKind | null;
  /** Shown beside a workspace that is being read or cannot be. */
  readonly note: string | null;
  /** 1-based position among its siblings, and how many siblings there are. */
  readonly posInSet: number;
  readonly setSize: number;
  /** Where the typed text matched the name, for highlighting. */
  readonly match: readonly (readonly [number, number])[];
}

const SEPARATOR = '\u0000';

export function folderKey(workspaceId: string, path: string): string {
  return `${workspaceId}${SEPARATOR}${path}`;
}

export function parseFolderKey(key: string): { workspaceId: string; path: string } {
  const at = key.indexOf(SEPARATOR);
  return at < 0
    ? { workspaceId: key, path: '' }
    : { workspaceId: key.slice(0, at), path: key.slice(at + 1) };
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export interface WorkspaceTree {
  /** Folder paths under each folder (`''` for the top), sorted by name. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly kinds: ReadonlyMap<string, FolderKind>;
}

/**
 * True when every folder along `path` is one a document can be put in: none
 * is hidden, a companion (or a copy of one) or an underscore support folder.
 */
export function isDestinationPath(path: string): boolean {
  return path.split('/').every(isDestinationFolderName);
}

/**
 * Index a workspace's flat folder list as a tree, filling in any parent left
 * out. Folders no document belongs in, and everything inside them, are left
 * out whatever the source listed (`isDestinationPath`).
 */
export function buildWorkspaceTree(folders: readonly PickerFolder[]): WorkspaceTree {
  const all = new Set<string>();
  const kinds = new Map<string, FolderKind>();
  for (const folder of folders) {
    const path = folder.path.replace(/^\/+|\/+$/g, '');
    if (!path || !isDestinationPath(path)) continue;
    for (let at: string = path; at && !all.has(at); at = parentOf(at)) all.add(at);
    if (folder.kind) kinds.set(path, folder.kind);
  }
  const children = new Map<string, string[]>();
  for (const path of all) {
    const parent = parentOf(path);
    const siblings = children.get(parent);
    if (siblings) siblings.push(path);
    else children.set(parent, [path]);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => collator.compare(nameOf(left), nameOf(right)));
  }
  return { children, kinds };
}

/** Where `query` matches `text`, ignoring case; empty when it does not. */
export function matchRanges(text: string, query: string): readonly (readonly [number, number])[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const at = text.toLocaleLowerCase().indexOf(needle);
  return at < 0 ? [] : [[at, at + needle.length]];
}

export interface PickerRowsInput {
  readonly workspaces: readonly PickerWorkspace[];
  readonly listings: ReadonlyMap<string, FolderListing>;
  readonly trees: ReadonlyMap<string, WorkspaceTree>;
  /** Keys of the open rows. Ignored while finding: matches show with every parent open. */
  readonly expanded: ReadonlySet<string>;
  /** What the person typed to find a folder. */
  readonly query: string;
}

function workspaceNote(listing: FolderListing | undefined): string | null {
  if (listing?.status === 'loading') return 'Looking…';
  if (listing?.status === 'unavailable') return listing.message;
  if (listing?.status === 'ready' && listing.partial) return 'Not every folder is shown';
  return null;
}

/**
 * The rows the picker shows, in order. Without a query, open rows show their
 * folders. With one, a folder shows when its name matches or something
 * beneath it does, and a workspace when its name matches or it holds a match.
 */
export function pickerRows(input: PickerRowsInput): PickerRow[] {
  const { workspaces, listings, trees, expanded } = input;
  const query = input.query.trim();
  const rows: PickerRow[] = [];

  for (const [index, workspace] of workspaces.entries()) {
    const listing = listings.get(workspace.id);
    const tree = listing?.status === 'ready' ? trees.get(workspace.id) : undefined;
    const rootKey = folderKey(workspace.id, '');

    // While finding: the folders that match, or hold one that does.
    let shown: Set<string> | null = null;
    if (query) {
      shown = new Set();
      if (tree) {
        for (const siblings of tree.children.values()) {
          for (const path of siblings) {
            if (matchRanges(nameOf(path), query).length === 0) continue;
            for (let at = path; at && !shown.has(at); at = parentOf(at)) shown.add(at);
          }
        }
      }
      // One still being read stays, saying so, until it is known to hold no match.
      const settled = listing?.status !== 'loading';
      if (shown.size === 0 && settled && matchRanges(workspace.name, query).length === 0) continue;
    }

    const topFolders = tree?.children.get('') ?? [];
    const rootEmpty =
      listing?.status === 'unavailable' || (tree !== undefined && topFolders.length === 0);
    const rootExpanded = !rootEmpty && (shown ? shown.size > 0 : expanded.has(rootKey));
    rows.push({
      path: rootKey,
      kind: 'directory',
      depth: 0,
      expanded: rootExpanded,
      ...(rootEmpty ? { empty: true } : {}),
      parentPath: null,
      workspaceId: workspace.id,
      folderPath: '',
      name: workspace.name,
      isWorkspace: true,
      folderKind: null,
      note: workspaceNote(listing),
      posInSet: index + 1,
      setSize: workspaces.length,
      match: matchRanges(workspace.name, query),
    });
    if (!rootExpanded || !tree) continue;

    const walk = (parent: string, depth: number) => {
      const siblings = (tree.children.get(parent) ?? []).filter(
        (path) => shown === null || shown.has(path),
      );
      for (const [position, path] of siblings.entries()) {
        const key = folderKey(workspace.id, path);
        const hasChildren = (tree.children.get(path)?.length ?? 0) > 0;
        const open = hasChildren && (shown ? hasShownChild(tree, path, shown) : expanded.has(key));
        rows.push({
          path: key,
          kind: 'directory',
          depth,
          expanded: open,
          ...(hasChildren ? {} : { empty: true }),
          parentPath: parent ? folderKey(workspace.id, parent) : rootKey,
          workspaceId: workspace.id,
          folderPath: path,
          name: nameOf(path),
          isWorkspace: false,
          folderKind: tree.kinds.get(path) ?? null,
          note: null,
          posInSet: position + 1,
          setSize: siblings.length,
          match: matchRanges(nameOf(path), query),
        });
        if (open) walk(path, depth + 1);
      }
    };
    walk('', 1);
  }
  return rows;
}

function hasShownChild(tree: WorkspaceTree, path: string, shown: ReadonlySet<string>): boolean {
  return (tree.children.get(path) ?? []).some((child) => shown.has(child));
}

/** The keys to open so the folder at `path` shows: its workspace and every folder above it. */
export function keysAbove(workspaceId: string, path: string): string[] {
  const keys = [folderKey(workspaceId, '')];
  for (let at = parentOf(path); at; at = parentOf(at)) keys.push(folderKey(workspaceId, at));
  return keys;
}

/** A choice, as words: `Work › Ocean › Tides`, or just `Work` for its top. */
export function describeChoice(choice: FolderChoice): string {
  return [choice.workspaceName, ...(choice.path ? choice.path.split('/') : [])].join(' › ');
}
