import { useState } from 'react';
import type {
  DocBlocksAccentColor,
  VscodeEditorSettings,
  VscodeProofingSettings,
  VscodeWriteCanvasSettings,
} from '@bendyline/docblocks/vscode';
import {
  AccentColorSettings,
  ProofingSettingsControls,
  SettingsDialog,
  WriteCanvasSettingsControls,
} from '@bendyline/docblocks-react/settings';

export interface VscodeSettingsButtonProps {
  settings: VscodeEditorSettings;
  onAutoSaveChange: (enabled: boolean) => void;
  onAccentColorChange: (color: DocBlocksAccentColor) => void;
  onWriteCanvasSettingsChange: (settings: VscodeWriteCanvasSettings) => void;
  onProofingSettingsChange: (settings: VscodeProofingSettings) => void;
}

export function VscodeSettingsButton({
  settings,
  onAutoSaveChange,
  onAccentColorChange,
  onWriteCanvasSettingsChange,
  onProofingSettingsChange,
}: VscodeSettingsButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="squisq-toolbar-button db-toolbar-settings-trigger"
        onClick={() => setDialogOpen(true)}
        aria-label="DocBlocks settings"
        data-tooltip="DocBlocks settings"
      >
        <SettingsGlyph />
      </button>

      {dialogOpen && (
        <SettingsDialog title="DocBlocks for VS Code settings" onClose={() => setDialogOpen(false)}>
          <AccentColorSettings
            value={settings.accentColor}
            name="vscode-accent-color"
            onChange={onAccentColorChange}
          />
          <WriteCanvasSettingsControls
            value={settings.writeCanvasSettings}
            onChange={onWriteCanvasSettingsChange}
          />
          <ProofingSettingsControls
            value={settings.proofingSettings}
            onChange={onProofingSettingsChange}
          />

          <fieldset className="db-settings-fieldset">
            <legend className="db-settings-legend">File saving</legend>
            <p className="db-settings-hint">
              Manual Save always works. Pending changes are also flushed safely when the editor
              closes.
            </p>
            <label className="db-settings-checkbox">
              <input
                type="checkbox"
                checked={settings.autoSave}
                onChange={(event) => onAutoSaveChange(event.currentTarget.checked)}
              />
              Automatically save files as you edit
            </label>
          </fieldset>
        </SettingsDialog>
      )}
    </>
  );
}

function SettingsGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g transform="translate(0 1)">
        <path d="M6.9 1.7h2.2l.35 1.55c.4.15.78.37 1.12.65l1.52-.47 1.1 1.9-1.18 1.08c.04.2.06.4.06.59s-.02.39-.06.59l1.18 1.08-1.1 1.9-1.52-.47c-.34.28-.72.5-1.12.65L9.1 12.3H6.9l-.35-1.55a4.2 4.2 0 0 1-1.12-.65l-1.52.47-1.1-1.9 1.18-1.08A3 3 0 0 1 3.93 7c0-.2.02-.39.06-.59L2.81 5.33l1.1-1.9 1.52.47c.34-.28.72-.5 1.12-.65L6.9 1.7Z" />
        <circle cx="8" cy="7" r="1.65" />
      </g>
    </svg>
  );
}
