import React, { useId, useRef, type ReactNode } from 'react';

export interface ComparePane {
  /** Stable identity, and the value `active` takes when this pane is chosen. */
  readonly key: string;
  /** Short name for the tab that shows this pane on a phone. */
  readonly tab: string;
  /** Accessible name of the pane's region. */
  readonly label: string;
  /** `db-conflict-version` for a whole version, `db-conflict-diff` for the differences. */
  readonly className: string;
  /**
   * Which side of the differences this version is: `removed` for the one
   * whose lines show as taken out (red, −), `inserted` for the one whose
   * lines show as added (green, +). Its tab, region and the choice that keeps
   * it all carry the same mark, so a choice can be read off the diff.
   */
  readonly side?: CompareSide;
  readonly children: ReactNode;
}

export type CompareSide = 'removed' | 'inserted';

export interface ComparePanesProps {
  readonly panes: readonly ComparePane[];
  /** The pane a phone shows. A wider screen shows them all, side by side. */
  readonly active: string;
  readonly onSelect: (key: string) => void;
  /** Extra class on the pane row, e.g. to give the differences more width. */
  readonly className?: string;
  readonly busy?: boolean;
  /** Hidden rather than unmounted, so the panes keep their scroll positions. */
  readonly hidden?: boolean;
}

/**
 * Versions of a document compared side by side on a wide screen and one at a
 * time behind tabs on a phone, where three columns leave none of them room to
 * be read. Both layouts are the same elements, and the stylesheet chooses
 * between them by the shell's width class, so there is one set of controls
 * whatever the screen and a resize never loses what the user was looking at.
 */
export function ComparePanes({
  panes,
  active,
  onSelect,
  className,
  busy,
  hidden,
}: ComparePanesProps) {
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabId = (key: string) => `${id}-tab-${key}`;
  const paneId = (key: string) => `${id}-pane-${key}`;

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = panes.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    onSelect(panes[next]!.key);
    tabs.current[next]?.focus();
  };

  return (
    <>
      <div className="db-compare-tabs" role="tablist" aria-label="Versions" hidden={hidden}>
        {panes.map((pane, index) => {
          const selected = pane.key === active;
          return (
            <button
              key={pane.key}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={tabId(pane.key)}
              aria-controls={paneId(pane.key)}
              aria-selected={selected}
              data-side={pane.side}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(pane.key)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {pane.tab}
            </button>
          );
        })}
      </div>
      <div
        className={['db-conflict-columns', className].filter(Boolean).join(' ')}
        aria-busy={busy}
        hidden={hidden}
      >
        {panes.map((pane) => (
          <section
            key={pane.key}
            id={paneId(pane.key)}
            className={
              pane.key === active ? `${pane.className} db-compare-pane--active` : pane.className
            }
            aria-label={pane.label}
            data-side={pane.side}
          >
            {pane.children}
          </section>
        ))}
      </div>
    </>
  );
}
