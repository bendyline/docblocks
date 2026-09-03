/**
 * @bendyline/docblocks-react — React components for DocBlocks
 */

// FileExplorer
export { FileExplorer } from './FileExplorer/index.js';
export type {
  FileExplorerProps,
  FileExplorerSortMode,
  FileTreeChange,
  FileTreeMutationHandler,
  NewFileFormat,
} from './FileExplorer/index.js';
export { FileTreeNode } from './FileExplorer/index.js';
export type { FileTreeNodeProps } from './FileExplorer/index.js';
export { useFileTree } from './FileExplorer/index.js';
export type { FileTreeActions, FileTreeReadIssue, FileTreeState } from './FileExplorer/index.js';

// WorkspacePicker
export { WorkspacePicker } from './WorkspacePicker/index.js';
export type { WorkspacePickerProps } from './WorkspacePicker/index.js';

// Proofing (grammar + spellcheck) is reached through the
// '@bendyline/docblocks-react/proofing' subpath rather than re-exported here:
// it pulls Squisq's harper adapter, and a host that never wires the capability
// should not carry it. See src/Proofing/public-api.ts.

// Calculation is likewise exposed only through the
// '@bendyline/docblocks-react/calculation' subpath. Its async factory is the
// boundary that keeps the optional IronCalc adapter out of hosts that do not
// ship the WASM engine. See src/Calculation/public-api.ts.

// DocBlocksShell
export { DocBlocksShell } from './DocBlocksShell/index.js';
export type { DocBlocksShellProps } from './DocBlocksShell/index.js';

// AppMenu
export { AppMenu } from './AppMenu/index.js';
export type { AccentColor, AppMenuProps, ThemePreference } from './AppMenu/index.js';

// Settings
export {
  AccentColorSettings,
  DEFAULT_PROOFING_PREFERENCES,
  DEFAULT_WRITE_CANVAS_FONT_SCHEME,
  loadProofingPreferences,
  ProofingSettingsControls,
  resolveWriteCanvasFonts,
  saveProofingPreferences,
  SettingsDialog,
  ThemeSettings,
  WRITE_CANVAS_FONT_SCHEMES,
  WriteCanvasSettingsControls,
} from './Settings/public-api.js';
export type {
  AccentColorSettingsProps,
  ProofingPreferences,
  ProofingSettingsControlsProps,
  SettingsDialogProps,
  ThemeSettingsProps,
  WriteCanvasFontScheme,
  WriteCanvasFontSchemeGroup,
  WriteCanvasFontSchemeOption,
  WriteCanvasPreferences,
  WriteCanvasSettingsControlsProps,
} from './Settings/public-api.js';

// Export
export {
  buildExportFilename,
  DEFAULT_OPTIONS,
  loadLastExportOptions,
  runExport,
  updateExportTargetExtension,
  createCoverImageSaveOutput,
  createDashboardImageSaveOutput,
  createImageSaveOutput,
  ExportToolbarControls,
} from './Export/index.js';
export type {
  ExportDestinationControl,
  ExportDestinationAdapter,
  ExportDestinationTarget,
  ExportToolbarControlsProps,
  ExportFormat,
  HtmlBundle,
  HtmlStyle,
  ExportOptions,
  ExportBlobSaver,
  CoverImageSaveAdapter,
  CoverImageSaveOutput,
  DashboardImageSaveAdapter,
  DashboardImageSaveOutput,
  ImageSaveAdapter,
  ImageSaveOutput,
} from './Export/index.js';
export { ExportDialog } from './Export/index.js';
export type { ExportDialogProps } from './Export/index.js';

// Hooks
export { useDocumentSession } from './hooks/index.js';
export type { UseDocumentSessionResult } from './hooks/index.js';
