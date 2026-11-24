import type { ReactNode } from 'react';
import type { ShellRoute } from './shell-routes.js';

export interface ShellNavItem {
  readonly key: string;
  readonly label: string;
  readonly route: ShellRoute;
  /** A number worth noticing (tasks due now, notes waiting). */
  readonly count?: number;
  readonly countLabel?: string;
}

/**
 * Home, Tasks and the workspace's kind folders, above the file tree. Small on
 * purpose: it ships in every launch, so the pages it opens load separately.
 */
export function ShellNav({
  items,
  current,
  onNavigate,
  children,
}: {
  items: readonly ShellNavItem[];
  /** The item showing in the main pane, if any. */
  current: string | null;
  onNavigate: (route: ShellRoute) => void;
  children?: ReactNode;
}) {
  return (
    <nav className="db-shell-nav" aria-label="Home and lists">
      <ul className="db-shell-nav-list">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className="db-shell-nav-item"
              aria-current={current === item.key ? 'page' : undefined}
              onClick={() => onNavigate(item.route)}
            >
              <span className="db-shell-nav-label">{item.label}</span>
              {item.count !== undefined && item.count > 0 && (
                <span className="db-shell-nav-count" aria-label={item.countLabel}>
                  {item.count}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {children}
    </nav>
  );
}
