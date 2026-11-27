import type { ComponentType } from 'react';
import type { FolderKind } from '@bendyline/docblocks/folders';
import { AskIcon, HomeIcon, JournalIcon, TasksIcon, UnfiledIcon } from '../icons.js';
import type { ShellRoute } from './shell-routes.js';

/** Which glyph a place wears: the shell's own pages, then the folder kinds (chats are Ask's). */
export type ShellNavIcon = 'home' | 'ask' | Exclude<FolderKind, 'chats'>;

export interface ShellNavItem {
  readonly key: string;
  readonly label: string;
  readonly icon: ShellNavIcon;
  readonly route: ShellRoute;
  /** A number worth noticing (tasks due now, notes waiting). */
  readonly count?: number;
  readonly countLabel?: string;
}

const GLYPHS: Record<ShellNavIcon, ComponentType> = {
  home: HomeIcon,
  tasks: TasksIcon,
  ask: AskIcon,
  journal: JournalIcon,
  unfiled: UnfiledIcon,
};

/**
 * Home, Tasks, Ask and the workspace's kind folders, as icons beside the app
 * menu in the sidebar header. Small on purpose: it ships in every launch, so
 * the pages it opens load separately. The label lives in each button's
 * accessible name and tooltip, with its count, since the glyph carries no text.
 */
export function ShellNav({
  items,
  current,
  onNavigate,
}: {
  items: readonly ShellNavItem[];
  /** The item showing in the main pane, if any. */
  current: string | null;
  onNavigate: (route: ShellRoute) => void;
}) {
  return (
    <nav className="db-shell-nav" aria-label="Home and lists">
      <ul className="db-shell-nav-list">
        {items.map((item) => {
          const count = item.count !== undefined && item.count > 0 ? item.count : null;
          const name =
            count !== null && item.countLabel ? `${item.label}, ${item.countLabel}` : item.label;
          const Glyph = GLYPHS[item.icon];
          return (
            <li key={item.key}>
              <button
                type="button"
                className="db-shell-nav-item"
                aria-label={name}
                title={name}
                aria-current={current === item.key ? 'page' : undefined}
                onClick={() => onNavigate(item.route)}
              >
                <Glyph />
                {count !== null && (
                  <span className="db-shell-nav-count" aria-hidden="true">
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
