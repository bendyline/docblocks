/**
 * The "This folder" section of the VS Code Settings dialog: the shared
 * workspace settings controls over the host's `.docblocks/workspace.json`.
 * Changes are drafted and saved together, as a patch over the file the host
 * last read. Version history is not offered here — the VS Code editor does
 * not keep version snapshots.
 */

import { useEffect, useMemo, useState } from 'react';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import type { VscodeWorkspaceSettingsState } from '@bendyline/docblocks/vscode';
import {
  diffWorkspaceSettings,
  EMPTY_WORKSPACE_SETTINGS,
  isEmptyWorkspaceSettingsPatch,
  tryApplyWorkspaceSettingsPatch,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from '@bendyline/docblocks/workspace-settings';
import {
  WorkspaceSettingsControls,
  type WorkspaceCatalogStatusView,
} from '@bendyline/docblocks-react/settings';

export interface VscodeWorkspaceSettingsProps {
  state: VscodeWorkspaceSettingsState;
  onSave: (patch: WorkspaceSettingsPatch) => Promise<void>;
  onRefreshOutputs: () => Promise<void>;
}

function catalogStatus(state: VscodeWorkspaceSettingsState): WorkspaceCatalogStatusView | null {
  const { catalog } = state;
  switch (catalog.state) {
    case 'pending':
      return { tone: 'info', message: 'Waiting for edits to settle…' };
    case 'running':
      return { tone: 'info', message: 'Updating the catalog…' };
    case 'error':
      return { tone: 'warning', message: catalog.message ?? 'The catalog could not be updated.' };
    case 'done': {
      if (catalog.message) return { tone: 'warning', message: catalog.message };
      const count = catalog.documentCount ?? 0;
      return {
        tone: 'info',
        message: `Up to date · ${count} ${count === 1 ? 'document' : 'documents'}`,
      };
    }
    default:
      return null;
  }
}

export function VscodeWorkspaceSettings({
  state,
  onSave,
  onRefreshOutputs,
}: VscodeWorkspaceSettingsProps) {
  const base = state.settings;
  const [draft, setDraft] = useState<WorkspaceSettings>(base ?? EMPTY_WORKSPACE_SETTINGS);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const themes = useMemo(() => getThemeSummaries(), []);

  useEffect(() => {
    if (!touched) setDraft(base ?? EMPTY_WORKSPACE_SETTINGS);
  }, [base, touched]);

  const patch = useMemo(() => diffWorkspaceSettings(base, draft), [base, draft]);
  const validation = useMemo(() => tryApplyWorkspaceSettingsPatch(base, patch), [base, patch]);
  const changed = !isEmptyWorkspaceSettingsPatch(patch);

  const save = async () => {
    if (!validation.ok) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
      setTouched(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="db-vscode-workspace-settings" aria-labelledby="db-vscode-workspace-heading">
      <h3 id="db-vscode-workspace-heading" className="db-settings-legend">
        This folder
      </h3>
      <p className="db-settings-hint">
        Saved in <code>.docblocks/workspace.json</code> and shared with everyone who opens the
        folder in DocBlocks.
      </p>
      {(!state.writable || state.message) && state.status !== 'loading' && (
        <p className="db-settings-status db-settings-status--warning" role="status">
          {state.message ?? 'These workspace settings cannot be changed here.'}
        </p>
      )}
      {state.status !== 'unavailable' && (
        <>
          <WorkspaceSettingsControls
            value={draft}
            onChange={(next) => {
              setDraft(next);
              setTouched(true);
              setError(null);
            }}
            themes={themes}
            disabled={!state.writable || saving}
            catalogStatus={catalogStatus(state)}
            onRegenerate={
              state.writable && !changed
                ? () => void onRefreshOutputs().catch((caught: unknown) => setError(String(caught)))
                : undefined
            }
            regenerating={state.catalog.state === 'running'}
          />
          {(error || (!validation.ok && changed)) && (
            <p className="db-settings-status db-settings-status--warning" role="alert">
              {error ?? (!validation.ok ? validation.message : null)}
            </p>
          )}
          {state.writable && (
            <div className="db-settings-status-row">
              <span />
              <button
                type="button"
                className="db-git-primary-btn"
                disabled={!changed || !validation.ok || saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save folder settings'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
