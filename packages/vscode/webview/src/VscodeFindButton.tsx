export interface VscodeFindButtonProps {
  active: boolean;
  onActiveChange: (active: boolean) => void;
}

export function VscodeFindButton({ active, onActiveChange }: VscodeFindButtonProps) {
  return (
    <button
      type="button"
      className={`squisq-toolbar-button${active ? ' squisq-toolbar-button--active' : ''}`}
      onClick={() => onActiveChange(!active)}
      aria-label="Find in document"
      aria-pressed={active}
      data-tooltip="Find in document"
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
