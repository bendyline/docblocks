import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AiKnowledgeAPI,
  AiKnowledgeAction,
  AiKnowledgeCatalog,
  AiKnowledgeState,
} from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';
import { HighlightedText } from '../components/HighlightedText.js';

/** "a 23 MB", "an 8 MB", "an 18 MB": the article follows the spoken number. */
function sizedArticle(bytes: number): string {
  const megabytes = String(Math.max(1, Math.round(bytes / 1024 ** 2)));
  const an =
    megabytes.startsWith('8') ||
    (megabytes.length % 3 === 2 && (megabytes.startsWith('11') || megabytes.startsWith('18')));
  return `${an ? 'an' : 'a'} ${megabytes} MB`;
}

/** "Version 2 · 1,024 documents · 3.4 MB" */
function catalogFacts(catalog: AiKnowledgeCatalog, version: string): string {
  return [
    `Version ${version}`,
    catalog.documents === null ? null : `${catalog.documents.toLocaleString()} documents`,
    catalog.downloadBytes === null ? null : `${(catalog.downloadBytes / 1024 ** 2).toFixed(1)} MB`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** What a collapsed row says about its catalog, so it need not be opened to check. */
function catalogSummary(catalog: AiKnowledgeCatalog): string {
  if (catalog.state === 'downloading')
    return catalog.percent === null
      ? 'Downloading…'
      : `Downloading ${Math.round(catalog.percent)}%`;
  if (catalog.state === 'error') return 'Needs attention';
  const use = catalog.enabled ? 'In use' : 'Not in use';
  return catalog.updateAvailable ? `${use} · Update available` : use;
}

/** Every occurrence of an already-lowercased `query` in `text`, for highlighting. */
function matchRanges(text: string, query: string): [number, number][] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (let at = haystack.indexOf(query); at >= 0; at = haystack.indexOf(query, at + query.length))
    ranges.push([at, at + query.length]);
  return ranges;
}

export function AiKnowledgeSettings({ knowledge }: { knowledge: AiKnowledgeAPI }) {
  const [state, setState] = useState<AiKnowledgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The provider's reason it offers no catalogs: an explanation, not an error. */
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [removing, setRemoving] = useState<string | null>(null);
  const binHeadingId = useId();
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [knowledge],
  );

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await knowledge.state();
        if (!live) return;
        if (!result.ok) {
          if (result.error.code === 'unsupported') setUnsupported(result.error.message);
          else setLoadError(result.error.message);
          return;
        }
        setState(result.value);
        setLoadError(null);
        setUnsupported(null);
        if (
          result.value.improvement?.downloading ||
          result.value.catalogs.some((catalog) => catalog.state === 'downloading')
        ) {
          timer = setTimeout(() => void refresh(), 1500);
        }
      } catch {
        if (live) setLoadError('Could not refresh knowledge catalogs. Try again.');
      }
    };
    void refresh();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [knowledge, revision]);

  const update = async (action: AiKnowledgeAction) => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await knowledge.update(action);
      if (current !== generation.current) return;
      if (!result.ok) setError(result.error.message);
      else {
        setRemoving(null);
        setRevision((value) => value + 1);
      }
    } catch {
      if (current === generation.current) setError('Could not change this catalog. Try again.');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const refresh = () => setRevision((value) => value + 1);
  // An action's error belongs to the surface it was taken on: opening or
  // closing the add dialog starts that surface without a stale message.
  const showAdd = (open: boolean) => {
    setError(null);
    setAdding(open);
    if (open) refresh();
  };
  const toggle = (catalogId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(catalogId)) next.add(catalogId);
      return next;
    });

  const downloaded =
    state?.catalogs.filter(
      (catalog) => catalog.installedVersion !== null || catalog.state === 'downloading',
    ) ?? [];
  const problem = error ?? loadError;
  if (unsupported)
    return (
      <section className="db-settings-ai-knowledge" aria-label="Knowledge catalogs">
        <h3 className="db-settings-select-header">Knowledge catalogs</h3>
        <p className="db-settings-hint">{unsupported}</p>
      </section>
    );
  return (
    <section className="db-settings-ai-knowledge" aria-label="Knowledge catalogs">
      <h3 className="db-settings-select-header">Knowledge catalogs</h3>
      <p className="db-settings-hint">
        Add reference material for AI writing, review, and chat. Relevant passages from enabled
        catalogs are included in each request.
      </p>
      {problem && !adding && (
        <p className="db-settings-hint db-settings-ai-error" role="alert">
          {problem}
        </p>
      )}
      {!state && !loadError && (
        <p className="db-settings-hint" role="status">
          Loading knowledge catalogs…
        </p>
      )}
      {!state && loadError && (
        <button
          type="button"
          className="db-settings-action db-settings-action--secondary"
          onClick={refresh}
        >
          Try again
        </button>
      )}
      {/* The provider offers this only while it would help; once chosen, the
          download runs quietly and the offer never returns. */}
      {state?.improvement && !state.improvement.downloading && (
        <p className="db-settings-hint">
          <button
            type="button"
            className="db-ai-link-button"
            disabled={busy}
            onClick={() => void update({ action: 'improve' })}
          >
            Improve knowledge results with {sizedArticle(state.improvement.downloadBytes)} model
            download
          </button>
        </p>
      )}
      {state && (
        <div className="db-knowledge-bin">
          <div className="db-knowledge-bin-header">
            <h4 id={binHeadingId} className="db-knowledge-bin-title">
              Downloaded catalogs
            </h4>
            <span className="db-knowledge-bin-count" aria-hidden="true">
              {downloaded.length}
            </span>
            <button
              type="button"
              className="db-settings-action db-settings-action--secondary"
              onClick={() => showAdd(true)}
            >
              Add catalog…
            </button>
          </div>
          {downloaded.length === 0 ? (
            <p className="db-settings-hint db-knowledge-bin-empty">
              No catalogs downloaded yet. Add a catalog to give AI writing, review, and chat
              reference material.
            </p>
          ) : (
            <ul className="db-knowledge-bin-list" aria-labelledby={binHeadingId}>
              {downloaded.map((catalog) => (
                <DownloadedCatalog
                  key={catalog.id}
                  catalog={catalog}
                  expanded={expanded.has(catalog.id)}
                  removing={removing === catalog.id}
                  busy={busy}
                  onToggle={() => toggle(catalog.id)}
                  onRemoving={(confirming) => setRemoving(confirming ? catalog.id : null)}
                  onAction={(action) => void update(action)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {adding && state && (
        <AddCatalogDialog
          catalogs={state.catalogs}
          busy={busy}
          problem={problem}
          onAction={(action) => void update(action)}
          onRefresh={refresh}
          onClose={() => showAdd(false)}
        />
      )}
    </section>
  );
}

function DownloadedCatalog({
  catalog,
  expanded,
  removing,
  busy,
  onToggle,
  onRemoving,
  onAction,
}: {
  catalog: AiKnowledgeCatalog;
  expanded: boolean;
  removing: boolean;
  busy: boolean;
  onToggle: () => void;
  onRemoving: (confirming: boolean) => void;
  onAction: (action: AiKnowledgeAction) => void;
}) {
  const bodyId = useId();
  return (
    <li className="db-knowledge-item">
      <button
        type="button"
        className="db-knowledge-item-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={onToggle}
      >
        <span
          className={`db-knowledge-item-caret${expanded ? ' db-knowledge-item-caret--open' : ''}`}
          aria-hidden="true"
        />
        <span className="db-knowledge-item-name">{catalog.name}</span>
        <span
          className={`db-knowledge-item-summary${
            catalog.state === 'error' ? ' db-knowledge-item-summary--error' : ''
          }`}
        >
          {catalogSummary(catalog)}
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className="db-knowledge-item-body">
          <p className="db-settings-hint">{catalog.description}</p>
          <p className="db-settings-hint">
            {catalogFacts(catalog, catalog.installedVersion ?? catalog.version)}
          </p>
          {catalog.message && (
            <p className="db-settings-hint" role={catalog.state === 'error' ? 'alert' : 'status'}>
              {catalog.message}
            </p>
          )}
          {catalog.state === 'downloading' ? (
            <div className="db-settings-ai-knowledge-actions">
              <progress
                max={100}
                value={catalog.percent ?? undefined}
                aria-label={`${catalog.name} download progress`}
              />
              <button
                type="button"
                className="db-settings-action db-settings-action--secondary"
                disabled={busy}
                onClick={() => onAction({ action: 'cancel', catalogId: catalog.id })}
              >
                Cancel download
              </button>
            </div>
          ) : (
            <div className="db-settings-ai-knowledge-actions">
              <label className="db-settings-checkbox">
                <input
                  type="checkbox"
                  checked={catalog.enabled}
                  disabled={busy}
                  onChange={(event) =>
                    onAction({
                      action: event.currentTarget.checked ? 'enable' : 'disable',
                      catalogId: catalog.id,
                    })
                  }
                />
                Use {catalog.name}
              </label>
              {catalog.updateAvailable && (
                <button
                  type="button"
                  className="db-settings-action"
                  disabled={busy}
                  onClick={() => onAction({ action: 'install', catalogId: catalog.id })}
                >
                  Update to {catalog.version}
                </button>
              )}
              <button
                type="button"
                className="db-settings-action db-settings-action--secondary"
                disabled={busy}
                onClick={() => onRemoving(true)}
              >
                Remove {catalog.name}…
              </button>
            </div>
          )}
          {removing && (
            <div role="group" aria-label={`Confirm removal of ${catalog.name}`}>
              <p className="db-settings-hint">
                Remove {catalog.name} from the connected AI service? Other apps using that service
                will also lose access to this catalog.
              </p>
              <div className="db-settings-ai-knowledge-actions">
                <button
                  type="button"
                  className="db-settings-action"
                  disabled={busy}
                  onClick={() => onAction({ action: 'remove', catalogId: catalog.id })}
                >
                  Confirm removal
                </button>
                <button
                  type="button"
                  className="db-settings-action db-settings-action--secondary"
                  onClick={() => onRemoving(false)}
                >
                  Keep catalog
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Every catalog the connected service offers, each with its own download
 * action. Opens over Settings, so it portals onto <body> like the other
 * stacked dialogs; the shared stack keeps Escape and Tab with the top one.
 */
function AddCatalogDialog({
  catalogs,
  busy,
  problem,
  onAction,
  onRefresh,
  onClose,
}: {
  catalogs: readonly AiKnowledgeCatalog[];
  busy: boolean;
  problem: string | null;
  onAction: (action: AiKnowledgeAction) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // Catalogs still to add come first. The order is fixed when the dialog
  // opens, so a card never jumps away as its download finishes.
  const [order] = useState(() =>
    [...catalogs]
      .sort((a, b) => Number(a.installedVersion !== null) - Number(b.installedVersion !== null))
      .map((catalog) => catalog.id),
  );
  const rank = (catalog: AiKnowledgeCatalog) => {
    const index = order.indexOf(catalog.id);
    return index < 0 ? order.length : index;
  };
  const needle = query.trim().toLowerCase();
  const matches = catalogs
    .filter((catalog) => `${catalog.name} ${catalog.description}`.toLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b));
  const dialog = (
    <Dialog
      title="Add knowledge catalog"
      size="wide"
      onClose={onClose}
      initialFocusRef={searchRef}
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
            Refresh catalogs
          </button>
          <button type="button" className="db-settings-action" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="db-settings-hint">
        Catalogs come from the connected AI service. Once one is downloaded, relevant passages from
        it are included in AI writing, review, and chat.
      </p>
      {problem && (
        <p className="db-settings-hint db-settings-ai-error" role="alert">
          {problem}
        </p>
      )}
      <label className="db-settings-text db-knowledge-search">
        Search catalogs
        <input
          ref={searchRef}
          className="db-settings-text-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      {/* Stays mounted so a search that empties the list is announced. */}
      <p className="db-settings-hint" role="status">
        {matches.length > 0
          ? ''
          : catalogs.length === 0
            ? 'The connected AI service doesn’t offer any catalogs right now.'
            : `No catalogs match “${query.trim()}”.`}
      </p>
      {matches.length > 0 && (
        <ul className="db-knowledge-catalog-list" aria-label="Catalogs">
          {matches.map((catalog) => (
            <li key={catalog.id} className="db-knowledge-catalog">
              <div className="db-knowledge-catalog-text">
                <strong className="db-knowledge-catalog-name">
                  <HighlightedText text={catalog.name} ranges={matchRanges(catalog.name, needle)} />
                </strong>
                <p className="db-settings-hint">
                  <HighlightedText
                    text={catalog.description}
                    ranges={matchRanges(catalog.description, needle)}
                  />
                </p>
                <p className="db-settings-hint">{catalogFacts(catalog, catalog.version)}</p>
                {catalog.message && (
                  <p
                    className="db-settings-hint"
                    role={catalog.state === 'error' ? 'alert' : 'status'}
                  >
                    {catalog.message}
                  </p>
                )}
              </div>
              <div className="db-knowledge-catalog-action">
                {catalog.state === 'downloading' ? (
                  <>
                    <progress
                      max={100}
                      value={catalog.percent ?? undefined}
                      aria-label={`${catalog.name} download progress`}
                    />
                    <button
                      type="button"
                      className="db-settings-action db-settings-action--secondary"
                      disabled={busy}
                      aria-label={`Cancel ${catalog.name} download`}
                      onClick={() => onAction({ action: 'cancel', catalogId: catalog.id })}
                    >
                      Cancel
                    </button>
                  </>
                ) : catalog.installedVersion !== null ? (
                  <span className="db-knowledge-catalog-added">
                    <span aria-hidden="true">✓ </span>Downloaded
                  </span>
                ) : (
                  <button
                    type="button"
                    className="db-settings-action"
                    disabled={busy}
                    aria-label={`Download ${catalog.name}`}
                    onClick={() => onAction({ action: 'install', catalogId: catalog.id })}
                  >
                    Download
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
