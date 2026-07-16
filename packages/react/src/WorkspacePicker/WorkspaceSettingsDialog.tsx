/**
 * WorkspaceSettingsDialog — per-workspace settings modal.
 *
 * Lets the user override the global versioning preference for a single
 * workspace (or fall back to inheriting it). The override is stored on
 * the WorkspaceDescriptor and persisted via `saveWorkspace`.
 */

import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import {
  isLocalWorkspaceType,
  resolveVersioningEnabled,
  type VersioningPreference,
} from '../preferences/versioning.js';
import { Dialog } from '../components/Dialog.js';

export type WorkspaceVersioningOverride = NonNullable<WorkspaceDescriptor['versioningOverride']>;

export interface WorkspaceSettingsDialogProps {
  workspace: WorkspaceDescriptor;
  /** Current global versioning preference — used to label "Inherit". */
  globalVersioningPreference: VersioningPreference;
  /** Apply a new override and close the dialog. */
  onChange: (override: WorkspaceVersioningOverride) => void;
  onClose: () => void;
}

const VERSIONING_LABELS: Record<VersioningPreference, string> = {
  on: 'on',
  'browser-only': 'on for browser workspaces, off for local folders',
  off: 'off',
};

export function WorkspaceSettingsDialog({
  workspace,
  globalVersioningPreference,
  onChange,
  onClose,
}: WorkspaceSettingsDialogProps) {
  // Treat absent/undefined as 'inherit' for the radio state.
  const current: WorkspaceVersioningOverride = workspace.versioningOverride ?? 'inherit';

  const isLocal = isLocalWorkspaceType(workspace.type);
  const inheritedEnabled = resolveVersioningEnabled(
    { ...workspace, versioningOverride: 'inherit' },
    globalVersioningPreference,
  );
  const inheritLabel = `Inherit default — currently ${VERSIONING_LABELS[globalVersioningPreference]} (${inheritedEnabled ? 'on' : 'off'} for this workspace)`;

  return (
    <Dialog title="Workspace settings" onClose={onClose}>
      <p className="db-settings-hint">
        <strong>{workspace.name}</strong> &middot;{' '}
        {isLocal ? 'Local folder workspace' : 'Browser workspace'}
      </p>

      <fieldset className="db-settings-fieldset">
        <legend className="db-settings-legend">Version history</legend>
        <p className="db-settings-hint">
          Controls whether DocBlocks keeps prior revisions in{' '}
          <code>&lt;name&gt;_files/.versions/</code> for documents in this workspace.
        </p>
        <label className="db-settings-radio">
          <input
            type="radio"
            name="ws-versioning"
            value="inherit"
            checked={current === 'inherit'}
            onChange={() => onChange('inherit')}
          />
          {inheritLabel}
        </label>
        <label className="db-settings-radio">
          <input
            type="radio"
            name="ws-versioning"
            value="on"
            checked={current === 'on'}
            onChange={() => onChange('on')}
          />
          On for this workspace
        </label>
        <label className="db-settings-radio">
          <input
            type="radio"
            name="ws-versioning"
            value="off"
            checked={current === 'off'}
            onChange={() => onChange('off')}
          />
          Off for this workspace
        </label>
      </fieldset>
    </Dialog>
  );
}
