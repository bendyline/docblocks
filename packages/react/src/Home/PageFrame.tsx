import type { DragEvent, ReactNode } from 'react';

/**
 * The frame every shell page shares. It is a folder view underneath, so the
 * desktop titlebar's drag strip and the phone's way back to the files apply
 * to it as they do to the folder page it grew out of.
 */
export function PageFrame({
  eyebrow,
  title,
  subtitle,
  actions,
  singlePane,
  onShowFiles,
  label,
  wide,
  dropping,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: {
  eyebrow?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  /** Controls at the end of the header. */
  actions?: ReactNode;
  singlePane: boolean;
  onShowFiles: () => void;
  /** Names the page for assistive technology when the title alone is ambiguous. */
  label?: string;
  /** Room for a board of columns. */
  wide?: boolean;
  /** Files are being dragged over the page and can be dropped. */
  dropping?: boolean;
  onDragOver?: (event: DragEvent) => void;
  onDragLeave?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  children: ReactNode;
}) {
  return (
    <section
      className={`db-folder-view db-page${wide ? ' db-page--wide' : ''}`}
      aria-label={label ?? title}
      data-dropping={dropping || undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {singlePane && (
        <button type="button" className="db-mobile-back" onClick={onShowFiles}>
          Back to files
        </button>
      )}
      <header className="db-page-header">
        <div className="db-page-heading">
          {eyebrow && <p className="db-page-eyebrow">{eyebrow}</p>}
          <h1 className="db-page-title">{title}</h1>
          {subtitle && <p className="db-page-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="db-page-header-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function PageSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="db-page-section" aria-label={title}>
      <h2 className="db-page-section-title">
        <span>{title}</span>
        {count !== undefined && <span className="db-page-count">{count}</span>}
        {action && <span className="db-page-section-action">{action}</span>}
      </h2>
      {children}
    </section>
  );
}
