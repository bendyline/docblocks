/**
 * A button that drops down every workspace on this device as a tree, each
 * workspace a root with its folders beneath, and a field to find a folder by
 * name. One click on a folder (or on a workspace, for its top) chooses it; the
 * chevron beside it opens it without choosing.
 *
 * Every workspace starts open, so its folders show at once and a click meant
 * to open one never files something at its top. The open workspace (the
 * source's first) answers from what is already known; the others are read as
 * the dropdown opens. The keys follow the file tree's (`treeKeyAction`).
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { HighlightedText } from '../components/HighlightedText.js';
import { TreeEntryIcon } from '../FileExplorer/TreeEntryIcon.js';
import { resolveActiveRow, TREE_NAV_KEYS, treeKeyAction } from '../FileExplorer/tree-keyboard.js';
import { DisclosureIcon, WorkspaceRootIcon } from '../icons.js';
import {
  buildWorkspaceTree,
  folderKey,
  keysAbove,
  parseFolderKey,
  pickerRows,
  type FolderChoice,
  type FolderListing,
  type PickerRow,
  type WorkspaceFolders,
  type WorkspaceFolderSource,
  type WorkspaceTree,
} from './folder-tree.js';

export interface WorkspaceFolderPickerProps {
  /** The button's words: `File in…`. */
  readonly label: string;
  /** The button's name when its words say less: `File “Tides” in…`. */
  readonly triggerLabel?: string;
  readonly triggerClassName?: string;
  readonly disabled?: boolean;
  readonly source: WorkspaceFolderSource;
  /** A folder to start on (a suggestion), shown with the folders above it open. */
  readonly initial?: { readonly workspaceId: string; readonly path: string } | null;
  /** Why a folder cannot be chosen (it is where the thing already is), or null. */
  readonly unavailable?: (choice: FolderChoice) => string | null;
  readonly onChoose: (choice: FolderChoice) => void;
}

export function WorkspaceFolderPicker({
  label,
  triggerLabel,
  triggerClassName,
  disabled = false,
  source,
  initial = null,
  unavailable,
  onChoose,
}: WorkspaceFolderPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={['db-folder-picker-trigger', triggerClassName].filter(Boolean).join(' ')}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || open) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {label}
        <span className="db-folder-picker-caret" aria-hidden="true">
          <DisclosureIcon />
        </span>
      </button>
      {open && (
        <FolderPickerPanel
          id={panelId}
          label={triggerLabel ?? label}
          triggerRef={triggerRef}
          source={source}
          initial={initial}
          unavailable={unavailable}
          onChoose={(choice) => {
            close(true);
            onChoose(choice);
          }}
          onClose={close}
        />
      )}
    </>
  );
}

const READ_FAILED = "DocBlocks couldn't read its folders.";
/** Clearance kept between the dropdown and its button, and the window's edges. */
const GAP = 4;
const EDGE = 8;

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

function ask(source: WorkspaceFolderSource, workspaceId: string) {
  try {
    return source.listFolders(workspaceId);
  } catch {
    return { status: 'unavailable', message: READ_FAILED } satisfies WorkspaceFolders;
  }
}

/** Hang the dropdown under its button, right edges aligned, or above it when there is more room. */
function placePanel(panel: HTMLElement, trigger: HTMLElement) {
  const anchor = trigger.getBoundingClientRect();
  const width = panel.offsetWidth;
  const below = window.innerHeight - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  const upward = panel.scrollHeight > below && above > below;
  panel.style.maxHeight = `${Math.max(160, upward ? above : below)}px`;
  const left = Math.min(
    Math.max(EDGE, anchor.right - width),
    Math.max(EDGE, window.innerWidth - width - EDGE),
  );
  panel.style.left = `${left}px`;
  if (upward) {
    panel.style.top = '';
    panel.style.bottom = `${window.innerHeight - anchor.top + GAP}px`;
  } else {
    panel.style.bottom = '';
    panel.style.top = `${anchor.bottom + GAP}px`;
  }
}

function FolderPickerPanel({
  id,
  label,
  triggerRef,
  source,
  initial,
  unavailable,
  onChoose,
  onClose,
}: {
  id: string;
  label: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  source: WorkspaceFolderSource;
  initial: { readonly workspaceId: string; readonly path: string } | null;
  unavailable: ((choice: FolderChoice) => string | null) | undefined;
  onChoose: (choice: FolderChoice) => void;
  onClose: (returnFocus: boolean) => void;
}) {
  const { workspaces } = source;
  const mounted = useRef(true);

  // Every workspace is asked as the dropdown opens; answers already known
  // (the open workspace's index) show on the first paint.
  const waiting = useRef(new Map<string, Promise<WorkspaceFolders>>());
  const [listings, setListings] = useState<ReadonlyMap<string, FolderListing>>(() => {
    const known = new Map<string, FolderListing>();
    for (const workspace of workspaces) {
      const answer = ask(source, workspace.id);
      if (isThenable(answer)) waiting.current.set(workspace.id, answer);
      known.set(workspace.id, isThenable(answer) ? { status: 'loading' } : answer);
    }
    return known;
  });
  useEffect(() => {
    mounted.current = true;
    for (const [workspaceId, answer] of waiting.current) {
      const settle = (listing: FolderListing) => {
        if (mounted.current) setListings((current) => new Map(current).set(workspaceId, listing));
      };
      void answer.then(settle, () => settle({ status: 'unavailable', message: READ_FAILED }));
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  const treeCache = useRef(new WeakMap<object, WorkspaceTree>());
  const trees = useMemo(() => {
    const built = new Map<string, WorkspaceTree>();
    for (const [workspaceId, listing] of listings) {
      if (listing.status !== 'ready') continue;
      let tree = treeCache.current.get(listing);
      if (!tree) {
        tree = buildWorkspaceTree(listing.folders);
        treeCache.current.set(listing, tree);
      }
      built.set(workspaceId, tree);
    }
    return built;
  }, [listings]);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        ...workspaces.map((workspace) => folderKey(workspace.id, '')),
        ...(initial ? keysAbove(initial.workspaceId, initial.path) : []),
      ]),
  );
  const suggestedKey = initial ? folderKey(initial.workspaceId, initial.path) : null;
  const [active, setActive] = useState<string | null>(suggestedKey);
  const [query, setQuery] = useState('');

  const rows = useMemo(
    () => pickerRows({ workspaces, listings, trees, expanded, query }),
    [workspaces, listings, trees, expanded, query],
  );
  const activeKey = resolveActiveRow(rows, active, null);

  const choiceFor = useCallback(
    (key: string): FolderChoice => {
      const { workspaceId, path } = parseFolderKey(key);
      const workspaceName = workspaces.find((workspace) => workspace.id === workspaceId)?.name;
      return { workspaceId, workspaceName: workspaceName ?? '', path };
    },
    [workspaces],
  );
  /** Why the row at `key` cannot be chosen, or null when it can. */
  const reasonFor = useCallback(
    (key: string): string | null => {
      const choice = choiceFor(key);
      const listing = listings.get(choice.workspaceId);
      if (listing?.status === 'unavailable') return listing.message;
      return unavailable?.(choice) ?? null;
    },
    [choiceFor, listings, unavailable],
  );
  const choose = (key: string) => {
    if (reasonFor(key) === null) onChoose(choiceFor(key));
  };
  const setOpen = (key: string, open: boolean) =>
    setExpanded((current) => {
      if (current.has(key) === open) return current;
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  const panelRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  // Placed before it paints, and again whenever its rows or the page move.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (panel && trigger) placePanel(panel, trigger);
  });
  useEffect(() => {
    const place = (event?: Event) => {
      const panel = panelRef.current;
      const trigger = triggerRef.current;
      // Scrolling the tree itself moves nothing.
      if (!panel || !trigger || (event && panel.contains(event.target as Node))) return;
      placePanel(panel, trigger);
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [triggerRef]);

  // A press anywhere else puts it away, choosing nothing.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose, triggerRef]);

  useEffect(() => {
    // A touch screen would raise its keyboard over the folders: there the
    // field waits to be tapped, and the dropdown itself takes focus.
    const touchOnly =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    (touchOnly ? panelRef.current : findRef.current)?.focus();
  }, []);

  // Focus follows the keys: move it once the row it went to has rendered.
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    const row = [
      ...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
    ].find((element) => element.dataset.key === key);
    if (!row) return;
    pendingFocus.current = null;
    row.focus();
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  });
  const focusRow = (key: string) => {
    pendingFocus.current = key;
    setActive(key);
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The row the key was pressed on; the roving one when it came from elsewhere.
    const fromKey =
      (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')?.dataset.key ??
      activeKey;
    if (fromKey === null || fromKey === undefined) return;
    const row = rows.find((candidate) => candidate.path === fromKey);
    if (TREE_NAV_KEYS.has(event.key)) {
      event.preventDefault();
      const action = treeKeyAction(rows, fromKey, event.key);
      if (action.type === 'focus') focusRow(action.path);
      else if (action.type === 'expand') setOpen(action.path, true);
      else if (action.type === 'collapse') setOpen(action.path, false);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && row) {
      event.preventDefault();
      if (reasonFor(row.path) === null) choose(row.path);
      else if (!row.empty) setOpen(row.path, !row.expanded);
      return;
    }
    // Typing on the tree finds, as it would in the field.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setQuery((current) => current + event.key);
      findRef.current?.focus();
    }
  };

  const onFindKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && query.trim()) {
      // The first folder found, as a menu takes its first match.
      const first = rows.find((row) => row.match.length > 0 && reasonFor(row.path) === null);
      if (!first) return;
      event.preventDefault();
      choose(first.path);
      return;
    }
    if (event.key !== 'ArrowDown') return;
    const target = rows.find((row) => row.path === activeKey) ?? rows[0];
    if (!target) return;
    event.preventDefault();
    focusRow(target.path);
  };

  const anyLoading = [...listings.values()].some((listing) => listing.status === 'loading');
  const finding = query.trim() !== '';

  const panel = (
    <div
      ref={panelRef}
      id={id}
      className="db-folder-picker"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      onBlur={(event) => {
        // Tabbing out of it puts it away, as leaving a menu does.
        const next = event.relatedTarget as Node | null;
        if (next && !panelRef.current?.contains(next) && !triggerRef.current?.contains(next)) {
          onClose(false);
        }
      }}
    >
      <input
        ref={findRef}
        type="search"
        className="db-folder-picker-find"
        placeholder="Find a folder"
        aria-label="Find a folder"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onFindKeyDown}
      />
      <div
        ref={treeRef}
        className="db-folder-picker-tree"
        role="tree"
        aria-label="Workspaces and folders"
        aria-busy={anyLoading || undefined}
        onKeyDown={onTreeKeyDown}
      >
        {rows.map((row) => (
          <PickerTreeRow
            key={row.path}
            row={row}
            focusable={row.path === activeKey}
            suggested={row.path === suggestedKey}
            reason={reasonFor(row.path)}
            onFocus={() => setActive(row.path)}
            onChoose={() => choose(row.path)}
            onToggle={() => setOpen(row.path, !row.expanded)}
          />
        ))}
      </div>
      {finding && rows.length === 0 && !anyLoading && (
        <p className="db-folder-picker-empty" role="status">
          No folder is called “{query.trim()}”.
        </p>
      )}
    </div>
  );
  return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}

function PickerTreeRow({
  row,
  focusable,
  suggested,
  reason,
  onFocus,
  onChoose,
  onToggle,
}: {
  row: PickerRow;
  focusable: boolean;
  suggested: boolean;
  reason: string | null;
  onFocus: () => void;
  onChoose: () => void;
  onToggle: () => void;
}) {
  const classes = [
    'db-tree-row',
    'db-folder-picker-row',
    row.isWorkspace ? 'db-folder-picker-row--workspace' : '',
    reason !== null ? 'db-folder-picker-row--unavailable' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const note = row.note ?? (suggested ? 'Suggested' : null);
  return (
    <div
      className={classes}
      role="treeitem"
      data-key={row.path}
      style={{ paddingLeft: row.depth * 16 + 4 }}
      aria-level={row.depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={row.empty ? undefined : row.expanded}
      aria-selected={false}
      aria-disabled={reason !== null || undefined}
      aria-description={reason ?? note ?? undefined}
      title={reason ?? undefined}
      tabIndex={focusable ? 0 : -1}
      onFocus={onFocus}
      onClick={onChoose}
    >
      <span
        className="db-tree-icon db-folder-picker-disclosure"
        onClick={(event) => {
          // Opening a folder is not choosing it.
          event.stopPropagation();
          if (!row.empty) onToggle();
        }}
      >
        {row.empty ? null : <DisclosureIcon />}
      </span>
      {row.isWorkspace ? (
        <span className="db-tree-glyph" aria-hidden="true">
          <WorkspaceRootIcon />
        </span>
      ) : (
        <TreeEntryIcon glyph={row.folderKind ?? 'folder'} />
      )}
      <span className="db-tree-label">
        <HighlightedText text={row.name} ranges={row.match} />
      </span>
      {note && (
        <span className="db-folder-picker-note" aria-hidden="true">
          {note}
        </span>
      )}
    </div>
  );
}
