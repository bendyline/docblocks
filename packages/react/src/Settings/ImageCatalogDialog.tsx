import { useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../components/Dialog.js';

export function ImageCatalogDialog<
  T extends { id: string; label: string; description: string | null },
>({
  title,
  items,
  description,
  busy,
  failure,
  renderRow,
  onRefresh,
  onClose,
}: {
  title: string;
  items: readonly T[];
  description: string;
  busy: boolean;
  failure: string | null;
  renderRow: (item: T) => ReactNode;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLocaleLowerCase();
  const matches = items.filter((item) =>
    `${item.label} ${item.description ?? ''}`.toLocaleLowerCase().includes(needle),
  );
  return (
    <Dialog
      title={title}
      size="wide"
      onClose={onClose}
      initialFocusRef={search}
      className="db-knowledge-add-dialog"
      bodyClassName="db-knowledge-add-body"
      footer={
        <>
          <button
            type="button"
            className="db-settings-action db-settings-action--secondary"
            disabled={busy}
            onClick={onRefresh}
          >
            Refresh catalog
          </button>
          <button type="button" className="db-settings-action" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="db-settings-hint">{description}</p>
      {failure && (
        <p className="db-settings-hint db-settings-ai-error" role="alert">
          {failure}
        </p>
      )}
      <label className="db-settings-text db-knowledge-search">
        Search catalog
        <input
          ref={search}
          type="search"
          className="db-settings-text-input"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <p className="db-settings-hint" role="status">
        {matches.length
          ? ''
          : items.length
            ? `No matches for “${query.trim()}”.`
            : 'No compatible downloads are available right now.'}
      </p>
      <ul className="db-settings-speech-models">{matches.map(renderRow)}</ul>
    </Dialog>
  );
}
