export interface FindButtonProps {
  readonly active: boolean;
  readonly onActiveChange: (active: boolean) => void;
  /** Platform label for the shortcut (e.g. `Ctrl+F` or `⌘F`), shown in the tooltip. */
  readonly shortcutLabel?: string;
}

/**
 * Toolbar toggle for Squisq's Find mode. Squisq ships the find bar but no
 * trigger, so every host that mounts `EditorShell` renders this in a toolbar
 * slot and passes the state through `findMode` / `onFindModeChange`.
 */
export function FindButton({ active, onActiveChange, shortcutLabel }: FindButtonProps) {
  const tooltip = shortcutLabel ? `Find in document (${shortcutLabel})` : 'Find in document';
  return (
    <button
      type="button"
      className={`squisq-toolbar-button${active ? ' squisq-toolbar-button--active' : ''}`}
      onClick={() => onActiveChange(!active)}
      aria-label="Find in document"
      aria-pressed={active}
      data-tooltip={tooltip}
    >
      <FindGlyph />
    </button>
  );
}

function FindGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="6.75" cy="6.75" r="4.25" />
      <path d="m10 10 3.5 3.5" />
    </svg>
  );
}
