import { useEffect, useRef, useState } from 'react';
import type {
  AiKnowledgeAPI,
  AiKnowledgeAction,
  AiKnowledgeState,
} from '@bendyline/docblocks/host';

/** "a 23 MB", "an 8 MB", "an 18 MB": the article follows the spoken number. */
function sizedArticle(bytes: number): string {
  const megabytes = String(Math.max(1, Math.round(bytes / 1024 ** 2)));
  const an =
    megabytes.startsWith('8') ||
    (megabytes.length % 3 === 2 && (megabytes.startsWith('11') || megabytes.startsWith('18')));
  return `${an ? 'an' : 'a'} ${megabytes} MB`;
}

export function AiKnowledgeSettings({ knowledge }: { knowledge: AiKnowledgeAPI }) {
  const [state, setState] = useState<AiKnowledgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [browse, setBrowse] = useState(false);
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
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
          setLoadError(result.error.message);
          return;
        }
        setState(result.value);
        setLoadError(null);
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

  const visible =
    state?.catalogs.filter(
      (catalog) =>
        (browse || catalog.installedVersion !== null || catalog.state === 'downloading') &&
        `${catalog.name} ${catalog.description}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  return (
    <section className="db-settings-ai-knowledge" aria-label="Knowledge catalogs">
      <h3 className="db-settings-select-header">Knowledge catalogs</h3>
      <p className="db-settings-hint">
        Add reference material for AI writing, review, and chat. Relevant passages from enabled
        catalogs are included in each request.
      </p>
      {(error ?? loadError) && (
        <p className="db-settings-hint db-settings-ai-error" role="alert">
          {error ?? loadError}
        </p>
      )}
      {!state && !loadError && (
        <p className="db-settings-hint" role="status">
          Loading knowledge catalogs…
        </p>
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
      <div className="db-settings-ai-knowledge-actions">
        <button
          type="button"
          className="db-settings-action db-settings-action--secondary"
          disabled={busy}
          onClick={() => setBrowse(!browse)}
        >
          {browse ? 'Show downloaded catalogs' : 'Browse additional catalogs'}
        </button>
        <button
          type="button"
          className="db-settings-action db-settings-action--secondary"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh catalogs
        </button>
      </div>
      {state && (
        <label className="db-settings-select">
          <span className="db-settings-select-header">Find a catalog</span>
          <input
            className="db-settings-select-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      )}
      {state && visible.length === 0 && (
        <p className="db-settings-hint">
          {browse
            ? 'No matching catalogs are available.'
            : 'No downloaded catalogs match. Browse additional catalogs to add reference material.'}
        </p>
      )}
      <ul className="db-settings-ai-knowledge-list">
        {visible.map((catalog) => (
          <li key={catalog.id}>
            <strong>{catalog.name}</strong>
            <p className="db-settings-hint">{catalog.description}</p>
            <p className="db-settings-hint">
              Version {catalog.installedVersion ?? catalog.version}
              {catalog.documents === null
                ? ''
                : ` · ${catalog.documents.toLocaleString()} documents`}
              {catalog.downloadBytes === null
                ? ''
                : ` · ${(catalog.downloadBytes / 1024 ** 2).toFixed(1)} MB download`}
            </p>
            {catalog.message && (
              <p className="db-settings-hint" role={catalog.state === 'error' ? 'alert' : 'status'}>
                {catalog.message}
              </p>
            )}
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
                  onClick={() => void update({ action: 'cancel', catalogId: catalog.id })}
                >
                  Cancel download
                </button>
              </>
            ) : (
              <div className="db-settings-ai-knowledge-actions">
                {catalog.installedVersion !== null && (
                  <label className="db-settings-checkbox">
                    <input
                      type="checkbox"
                      checked={catalog.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        void update({
                          action: event.currentTarget.checked ? 'enable' : 'disable',
                          catalogId: catalog.id,
                        })
                      }
                    />
                    Use {catalog.name}
                  </label>
                )}
                {(catalog.installedVersion === null || catalog.updateAvailable) && (
                  <button
                    type="button"
                    className="db-settings-action"
                    disabled={busy}
                    onClick={() => void update({ action: 'install', catalogId: catalog.id })}
                  >
                    {catalog.updateAvailable ? `Update to ${catalog.version}` : 'Download catalog'}
                  </button>
                )}
                {catalog.installedVersion !== null && (
                  <button
                    type="button"
                    className="db-settings-action db-settings-action--secondary"
                    disabled={busy}
                    onClick={() => setRemoving(catalog.id)}
                  >
                    Remove {catalog.name}…
                  </button>
                )}
              </div>
            )}
            {removing === catalog.id && (
              <div role="group" aria-label={`Confirm removal of ${catalog.name}`}>
                <p className="db-settings-hint">
                  Remove {catalog.name} from the connected AI service? Other apps using that service
                  will also lose access to this catalog.
                </p>
                <button
                  type="button"
                  className="db-settings-action"
                  disabled={busy}
                  onClick={() => void update({ action: 'remove', catalogId: catalog.id })}
                >
                  Confirm removal
                </button>
                <button
                  type="button"
                  className="db-settings-action db-settings-action--secondary"
                  onClick={() => setRemoving(null)}
                >
                  Keep catalog
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
