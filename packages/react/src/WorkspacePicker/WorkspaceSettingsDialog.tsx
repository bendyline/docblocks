/**
 * WorkspaceSettingsDialog — edits the active workspace's
 * `.docblocks/workspace.json`.
 *
 * Changes are drafted and written once on Save, as a field-level patch over
 * the file version the dialog was opened with (a concurrent change from
 * another window or a git pull is merged rather than overwritten). A file
 * that is invalid or was written by a newer DocBlocks is shown read-only.
 *
 * An older per-workspace version-history override stored in the browser is
 * pre-filled into the draft, so the first Save moves it into the file where
 * it travels with the folder.
 */

import { useEffect, useMemo, useState } from 'react';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import {
  diffWorkspaceSettings,
  EMPTY_WORKSPACE_SETTINGS,
  isEmptyWorkspaceSettingsPatch,
  isWorkspaceSettingsWritable,
  tryApplyWorkspaceSettingsPatch,
  type WorkspaceOutputsStatus,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
  type WorkspaceSettingsState,
} from '@bendyline/docblocks/workspace-settings';
import {
  isLocalWorkspaceType,
  resolveVersioningEnabled,
  type VersioningPreference,
} from '../preferences/versioning.js';
import { Dialog } from '../components/Dialog.js';
import {
  WorkspaceSettingsControls,
  type WorkspaceCatalogStatusView,
} from '../Settings/WorkspaceSettingsControls.js';

export interface WorkspaceSettingsDialogProps {
  workspace: WorkspaceDescriptor;
  /** Current global versioning preference — used to label "inherit". */
  globalVersioningPreference: VersioningPreference;
  settings: WorkspaceSettingsState;
  /** False when the host does not keep version history at all. */
  showVersionHistory: boolean;
  outputsStatus: WorkspaceOutputsStatus;
  /** Persist a patch; resolves once written. Rejections are shown in the dialog. */
  onSave: (patch: WorkspaceSettingsPatch) => Promise<void>;
  onRegenerate: () => void;
  onClose: () => void;
}

const VERSIONING_LABELS: Record<VersioningPreference, string> = {
  on: 'on',
  'browser-only': 'on for browser workspaces, off for local folders',
  off: 'off',
};

function initialDraft(workspace: WorkspaceDescriptor, settings: WorkspaceSettings | null) {
  const base = settings ?? EMPTY_WORKSPACE_SETTINGS;
  const legacy = workspace.versioningOverride;
  if (base.versionHistory?.enabled !== undefined || (legacy !== 'on' && legacy !== 'off')) {
    return base;
  }
  return {
    ...base,
    versionHistory: { ...(base.versionHistory ?? {}), enabled: legacy === 'on' },
  };
}

function catalogStatusView(status: WorkspaceOutputsStatus): WorkspaceCatalogStatusView | null {
  switch (status.state) {
    case 'pending':
      return { tone: 'info', message: 'Waiting for edits to settle…' };
    case 'running':
      return { tone: 'info', message: 'Updating the catalog…' };
    case 'error':
      return { tone: 'warning', message: status.message ?? 'The catalog could not be updated.' };
    case 'done': {
      if (status.message) return { tone: 'warning', message: status.message };
      const count = status.result?.documentCount ?? 0;
      return {
        tone: 'info',
        message: `Up to date · ${count} ${count === 1 ? 'document' : 'documents'}`,
      };
    }
    default:
      return null;
  }
}

export function WorkspaceSettingsDialog({
  workspace,
  globalVersioningPreference,
  settings,
  showVersionHistory,
  outputsStatus,
  onSave,
  onRegenerate,
  onClose,
}: WorkspaceSettingsDialogProps) {
  const writable = isWorkspaceSettingsWritable(settings);
  const base = settings.settings;
  const [draft, setDraft] = useState<WorkspaceSettings>(() =>
    initialDraft(workspace, settings.settings),
  );
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    // Follow re-reads (focus, another window, a git pull) until the user edits.
    if (!touched) setDraft(initialDraft(workspace, settings.settings));
  }, [settings.settings, touched, workspace]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const themes = useMemo(() => getThemeSummaries(), []);

  const patch = useMemo(() => diffWorkspaceSettings(base, draft), [base, draft]);
  const validation = useMemo(() => tryApplyWorkspaceSettingsPatch(base, patch), [base, patch]);
  const changed = !isEmptyWorkspaceSettingsPatch(patch);

  const isLocal = isLocalWorkspaceType(workspace.type);
  const inheritedEnabled = resolveVersioningEnabled(
    { ...workspace, versioningOverride: 'inherit' },
    globalVersioningPreference,
  );
  const inheritLabel = `App default — currently ${VERSIONING_LABELS[globalVersioningPreference]} (${inheritedEnabled ? 'on' : 'off'} here)`;

  const save = async () => {
    if (!validation.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(patch);
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const notice =
    settings.status === 'loading'
      ? 'Loading workspace settings…'
      : writable
        ? null
        : (settings.message ?? 'These workspace settings cannot be changed here.');

  return (
    <Dialog
      title="Workspace settings"
      size="wide"
      onClose={onClose}
      closeOnBackdrop={!changed}
      footer={
        writable ? (
          <>
            <button type="button" className="db-git-secondary-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="db-git-primary-btn"
              disabled={!changed || !validation.ok || saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <button type="button" className="db-git-secondary-btn" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      <p className="db-settings-hint">
        <strong>{workspace.name}</strong> &middot;{' '}
        {isLocal ? 'Local folder workspace' : 'Browser workspace'} &middot; saved in{' '}
        <code>.docblocks/workspace.json</code>
      </p>
      {notice && (
        <p className="db-settings-status db-settings-status--warning" role="status">
          {notice}
        </p>
      )}
      <WorkspaceSettingsControls
        value={draft}
        onChange={(next) => {
          setDraft(next);
          setTouched(true);
          setSaveError(null);
        }}
        themes={themes}
        disabled={!writable || saving}
        versionHistory={showVersionHistory ? { inheritLabel } : undefined}
        catalogStatus={catalogStatusView(outputsStatus)}
        onRegenerate={writable && !changed ? onRegenerate : undefined}
        regenerating={outputsStatus.state === 'running'}
      />
      {(saveError || (!validation.ok && changed)) && (
        <p className="db-settings-status db-settings-status--warning" role="alert">
          {saveError ?? (!validation.ok ? validation.message : null)}
        </p>
      )}
    </Dialog>
  );
}
