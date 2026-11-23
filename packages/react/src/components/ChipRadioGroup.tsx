/**
 * ChipRadioGroup — a row of pill buttons that behaves as one radio group:
 * one tab stop, arrow keys move the choice, and the choice moves focus with
 * it. Used for the Export dialog's format and style rows and the New
 * document gallery's type row.
 */

export interface ChipOption<T extends string> {
  key: T;
  label: string;
  title?: string;
}

export function ChipRadioGroup<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  /** The group's accessible name. */
  name: string;
  value: T;
  options: readonly ChipOption<T>[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="db-export-chips" role="radiogroup" aria-label={name}>
      {options.map((opt, index) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={`db-export-chip${active ? ' db-export-chip--active' : ''}`}
            onClick={() => onChange(opt.key)}
            onKeyDown={(event) => {
              const delta =
                event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : 0;
              if (!delta) return;
              event.preventDefault();
              const next = (index + delta + options.length) % options.length;
              onChange(options[next]!.key);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                [next]?.focus();
            }}
            title={opt.title}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
