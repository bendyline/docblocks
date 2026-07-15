/**
 * GitToolbarControl — per-file git actions in the editor toolbar.
 *
 * A single branch-glyph button (styled like the export trigger) opening a
 * small dropdown: view working-tree changes, per-file history, and "Open
 * on <host>" when a web remote is known. A dot overlay marks the selected
 * file as modified. Null-renders without a git context, a repository, or a
 * selected file. Deliberately has no editor dependency.
 */

import { useEffect, useRef, useState } from 'react';
import { useGitContext } from './GitContext.js';
import { isFileDirty } from './git-status.js';
import { useMenuKeyboard } from './useMenuKeyboard.js';

export interface GitToolbarControlProps {
  /** Currently selected file path (slash-prefixed), or null. */
  selectedFile: string | null;
}

export function GitToolbarControl({ selectedFile }: GitToolbarControlProps) {
  const git = useGitContext();
  const [menuOpen, setMenuOpen] = useState(false);
  /** Wraps trigger + menu — the outside-click hit test, not the menu itself. */
  const rootRef = useRef<HTMLDivElement>(null);
  const { menuRef, triggerRef, handleMenuKeyDown, handleTriggerKeyDown, closeMenu } =
    useMenuKeyboard(menuOpen, setMenuOpen);

  // Close on outside click (same pointerdown pattern as ExportToolbarControls).
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  if (!git || !git.repo || !selectedFile) return null;

  const dirty = isFileDirty(git.status, selectedFile);
  const label = dirty ? 'Git actions (file modified)' : 'Git actions';

  // Each of these replaces the menu with a dialog, so focus belongs there,
  // not back on the trigger.
  const openDiff = () => {
    closeMenu(false);
    git.openDialog({ kind: 'diff', path: selectedFile });
  };
  const openHistory = () => {
    closeMenu(false);
    git.openDialog({ kind: 'history', path: selectedFile });
  };
  const openOnRemote = () => {
    closeMenu(false);
    git.openOnRemote(selectedFile);
  };

  return (
    <div className="db-toolbar-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="squisq-toolbar-button db-git-toolbar-trigger"
        onClick={() => setMenuOpen((prev) => !prev)}
        onKeyDown={handleTriggerKeyDown}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-tooltip={label}
      >
        <BranchGlyph />
        {dirty && <span className="db-git-toolbar-dot" aria-hidden="true" />}
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className="db-toolbar-menu-dropdown"
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="db-toolbar-menu-item"
            disabled={!dirty}
            onClick={openDiff}
          >
            View changes
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="db-toolbar-menu-item"
            onClick={openHistory}
          >
            File history…
          </button>
          {git.remoteWeb && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-toolbar-menu-item"
              onClick={openOnRemote}
            >
              Open on {git.remoteWeb.host}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BranchGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4.5" cy="12" r="2" />
      <circle cx="11.5" cy="4" r="2" />
      <path d="M4.5 10V7.5A2.5 2.5 0 0 1 7 5h2.5" />
    </svg>
  );
}
