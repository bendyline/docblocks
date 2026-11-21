export interface SearchIndexSettingsControlsProps {
  /** Keep the open workspace's index on this device between launches. */
  keep: boolean;
  onKeepChange: (keep: boolean) => void;
  /** Delete the open workspace's stored index; it is built again. */
  onClear: () => void;
  /** Where the open workspace's index lives now; null before it opens. */
  persistence: 'persistent' | 'memory' | null;
}

function where(keep: boolean, persistence: 'persistent' | 'memory' | null): string | null {
  if (!keep) return 'The open workspace is indexed in memory and nothing is kept on this device.';
  if (persistence === 'memory') {
    return 'The open workspace is indexed in memory this session, because another window keeps its index.';
  }
  return null;
}

/**
 * Where the open workspace's search index lives. The index holds a copy of
 * the workspace's text in DocBlocks' own storage, so it gets a privacy
 * control of its own: keep it or not, and clear it.
 */
export function SearchIndexSettingsControls({
  keep,
  onKeepChange,
  onClear,
  persistence,
}: SearchIndexSettingsControlsProps) {
  const status = where(keep, persistence);
  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">Search index</legend>
      <p className="db-settings-hint">
        The index holds a copy of this workspace&apos;s text in DocBlocks&apos; own storage on this
        device, never in the workspace, so search is ready as soon as DocBlocks opens.
      </p>
      <label className="db-settings-checkbox">
        <input
          type="checkbox"
          checked={keep}
          onChange={(event) => onKeepChange(event.currentTarget.checked)}
        />
        Keep a search index for this workspace
      </label>
      <p className="db-settings-hint">
        Off, the index is built in memory each time the workspace opens, and the stored copy is
        deleted. Set for each workspace.
      </p>
      {status && (
        <p className="db-settings-hint" role="status" data-testid="search-index-status">
          {status}
        </p>
      )}
      {keep && (
        <>
          <button type="button" className="db-settings-action" onClick={onClear}>
            Clear search index
          </button>
          <p className="db-settings-hint">
            Deletes this workspace&apos;s stored index on this device and builds it again, which
            takes a while for a large workspace.
          </p>
        </>
      )}
    </fieldset>
  );
}
