/**
 * Workspace-scoped settings (`.docblocks/workspace.json`) for every folder in
 * the VS Code window.
 *
 * Each workspace folder gets core's shared settings store and catalog-output
 * scheduler over a `vscode.workspace.fs` adapter, so catalogs regenerate when
 * documents are saved in the DocBlocks editor, in a plain text editor, or by
 * another tool (file watchers), exactly as they do in the desktop app.
 * Generated files are written only in trusted, writable workspaces.
 */

import * as vscode from 'vscode';
import type { VscodeWorkspaceSettingsState } from '@bendyline/docblocks/vscode';
import {
  createWorkspaceOutputsScheduler,
  isWorkspaceSettingsWritable,
  LOADING_WORKSPACE_SETTINGS,
  readWorkspaceSettings,
  saveWorkspaceSettingsPatch,
  UNAVAILABLE_WORKSPACE_SETTINGS,
  WORKSPACE_SETTINGS_PATH,
  type WorkspaceOutputsIO,
  type WorkspaceOutputsRenderer,
  type WorkspaceOutputsScheduler,
  type WorkspaceSettingsPatch,
  type WorkspaceSettingsState,
} from '@bendyline/docblocks/workspace-settings';
import { createVscodeWorkspaceIO } from './workspaceOutputsIO.js';
import { isWorkspaceTrusted } from './workspaceTrust.js';

const DOCUMENT_GLOB = '**/*.{md,markdown,html,htm,docx,pdf,pptx,xlsx,csv}';
const SETTINGS_GLOB = `**/${WORKSPACE_SETTINGS_PATH}`;

interface FolderEntry {
  readonly folder: vscode.WorkspaceFolder;
  readonly io: WorkspaceOutputsIO;
  settings: WorkspaceSettingsState;
  scheduler: WorkspaceOutputsScheduler | null;
  stopStatus: (() => void) | null;
  lastLoggedMessage: string | null;
  generation: number;
}

let activeService: WorkspaceSettingsService | null = null;

/** The window's service, or null before activation (and in unit tests). */
export function getWorkspaceSettingsService(): WorkspaceSettingsService | null {
  return activeService;
}

/** Make `service` the window's service until the returned disposable runs. */
export function registerWorkspaceSettingsService(
  service: WorkspaceSettingsService,
): vscode.Disposable {
  activeService = service;
  return new vscode.Disposable(() => {
    if (activeService === service) activeService = null;
  });
}

let defaultRenderer: Promise<WorkspaceOutputsRenderer> | null = null;
function loadRenderer(): Promise<WorkspaceOutputsRenderer> {
  defaultRenderer ??= import('@bendyline/squisq-formats/html').then(
    ({ htmlToMarkdownDocSync, markdownDocToPlainHtml }) => ({
      renderCatalogHtml: (document, { title, themeId }) =>
        markdownDocToPlainHtml(document, { title, themeId }),
      importHtml: (html) => htmlToMarkdownDocSync(html),
    }),
  );
  return defaultRenderer;
}

function isWritableFolder(folder: vscode.WorkspaceFolder): boolean {
  return vscode.workspace.fs.isWritableFileSystem(folder.uri.scheme) !== false;
}

function isDirtyInEditor(uri: vscode.Uri): boolean {
  return vscode.workspace.textDocuments.some(
    (document) => document.isDirty && document.uri.toString() === uri.toString(),
  );
}

export class WorkspaceSettingsService implements vscode.Disposable {
  private readonly folders = new Map<string, FolderEntry>();
  private readonly changeEmitter = new vscode.EventEmitter<string>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Fires with a folder key whenever that folder's settings or catalog status change. */
  public readonly onDidChangeState = this.changeEmitter.event;

  public constructor(private readonly output: vscode.OutputChannel) {
    const settingsWatcher = vscode.workspace.createFileSystemWatcher(SETTINGS_GLOB);
    const documentWatcher = vscode.workspace.createFileSystemWatcher(DOCUMENT_GLOB);
    const onSettings = (uri: vscode.Uri) => {
      const entry = this.entryFor(uri);
      if (entry && this.relativePath(entry.folder, uri) === WORKSPACE_SETTINGS_PATH) {
        void this.reload(entry);
      }
    };
    const onDocument = (uri: vscode.Uri) => {
      const entry = this.entryFor(uri);
      entry?.scheduler?.notify(this.relativePath(entry.folder, uri) ?? undefined);
    };
    this.disposables.push(
      this.changeEmitter,
      settingsWatcher,
      documentWatcher,
      settingsWatcher.onDidCreate(onSettings),
      settingsWatcher.onDidChange(onSettings),
      settingsWatcher.onDidDelete(onSettings),
      documentWatcher.onDidCreate(onDocument),
      documentWatcher.onDidChange(onDocument),
      documentWatcher.onDidDelete(onDocument),
      // Watchers can be throttled or excluded (`files.watcherExclude`); a save
      // through VS Code is always observed here as well.
      vscode.workspace.onDidSaveTextDocument((document) => onDocument(document.uri)),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        for (const removed of event.removed) this.dropFolder(removed);
        for (const added of event.added) void this.reload(this.ensureFolder(added));
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        for (const entry of this.folders.values()) void this.reload(entry);
      }),
    );
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      void this.reload(this.ensureFolder(folder));
    }
  }

  /** Settings state for the folder that contains `uri`, for a webview. */
  public getState(uri: vscode.Uri): VscodeWorkspaceSettingsState {
    const entry = this.entryFor(uri);
    if (!entry) return this.toWire(null);
    return this.toWire(entry);
  }

  /** The key `onDidChangeState` reports for the folder containing `uri`. */
  public folderKeyFor(uri: vscode.Uri): string | null {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? folder.uri.toString() : null;
  }

  public async update(uri: vscode.Uri, patch: WorkspaceSettingsPatch): Promise<void> {
    const entry = this.entryFor(uri);
    if (!entry)
      throw new Error('Open the document from a workspace folder to use workspace settings.');
    this.assertWritable(entry);
    const generation = entry.generation;
    const saved = await saveWorkspaceSettingsPatch(entry.io, entry.settings, patch);
    if (generation !== entry.generation) return;
    this.apply(entry, saved);
  }

  public async regenerate(uri: vscode.Uri): Promise<void> {
    const entry = this.entryFor(uri);
    if (!entry) throw new Error('Open the document from a workspace folder to update its catalog.');
    this.assertWritable(entry);
    if (!entry.scheduler) throw new Error('No catalog is enabled for this folder.');
    const status = await entry.scheduler.regenerate({ force: true });
    if (status.state === 'error')
      throw new Error(status.message ?? 'The catalog could not be updated.');
  }

  /** Regenerate every folder's catalog (the `docblocks.refreshWorkspaceOutputs` command). */
  public async regenerateAll(): Promise<number> {
    let refreshed = 0;
    for (const entry of this.folders.values()) {
      if (!entry.scheduler) continue;
      await entry.scheduler.regenerate({ force: true });
      refreshed += 1;
    }
    return refreshed;
  }

  public dispose(): void {
    for (const entry of this.folders.values()) this.disposeScheduler(entry);
    this.folders.clear();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private assertWritable(entry: FolderEntry): void {
    if (!isWorkspaceTrusted()) {
      throw new Error('Trust this workspace to let DocBlocks change workspace settings.');
    }
    if (!isWritableFolder(entry.folder)) throw new Error('This workspace folder is read-only.');
  }

  private entryFor(uri: vscode.Uri): FolderEntry | null {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? this.ensureFolder(folder) : null;
  }

  private relativePath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string | null {
    const root = folder.uri.path.replace(/\/$/, '');
    return uri.path.startsWith(`${root}/`) ? uri.path.slice(root.length + 1) : null;
  }

  private ensureFolder(folder: vscode.WorkspaceFolder): FolderEntry {
    const key = folder.uri.toString();
    const existing = this.folders.get(key);
    if (existing) return existing;
    const entry: FolderEntry = {
      folder,
      io: createVscodeWorkspaceIO(folder.uri, { isDirty: isDirtyInEditor }),
      settings: LOADING_WORKSPACE_SETTINGS,
      scheduler: null,
      stopStatus: null,
      lastLoggedMessage: null,
      generation: 0,
    };
    this.folders.set(key, entry);
    return entry;
  }

  private dropFolder(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    const entry = this.folders.get(key);
    if (!entry) return;
    entry.generation += 1;
    this.disposeScheduler(entry);
    this.folders.delete(key);
  }

  private async reload(entry: FolderEntry): Promise<void> {
    const generation = ++entry.generation;
    const settings = await readWorkspaceSettings(entry.io);
    if (generation !== entry.generation || !this.folders.has(entry.folder.uri.toString())) return;
    this.apply(entry, settings);
  }

  private apply(entry: FolderEntry, settings: WorkspaceSettingsState): void {
    entry.settings = settings;
    const canGenerate = isWorkspaceTrusted() && isWritableFolder(entry.folder);
    if (!canGenerate) {
      this.disposeScheduler(entry);
    } else if (!entry.scheduler) {
      const scheduler = createWorkspaceOutputsScheduler({
        workspaceId: entry.folder.uri.toString(),
        provider: entry.io,
        settings: settings.settings,
        renderer: loadRenderer,
      });
      entry.scheduler = scheduler;
      entry.stopStatus = scheduler.subscribe(() => {
        this.logStatus(entry);
        this.changeEmitter.fire(entry.folder.uri.toString());
      });
    } else {
      entry.scheduler.updateSettings(settings.settings);
    }
    this.changeEmitter.fire(entry.folder.uri.toString());
  }

  private disposeScheduler(entry: FolderEntry): void {
    entry.stopStatus?.();
    entry.stopStatus = null;
    entry.scheduler?.dispose();
    entry.scheduler = null;
  }

  private logStatus(entry: FolderEntry): void {
    const status = entry.scheduler?.getStatus();
    const message =
      status && (status.state === 'error' || status.state === 'done') ? status.message : null;
    if (message && message !== entry.lastLoggedMessage) {
      this.output.appendLine(`[${entry.folder.name}] ${message}`);
    }
    entry.lastLoggedMessage = message;
  }

  private toWire(entry: FolderEntry | null): VscodeWorkspaceSettingsState {
    if (!entry) {
      return {
        status: 'unavailable',
        settings: null,
        writable: false,
        message: 'Workspace settings need a document inside an open folder.',
        catalog: { state: 'idle', message: null, documentCount: null },
      };
    }
    const settings = entry.settings ?? UNAVAILABLE_WORKSPACE_SETTINGS;
    const trusted = isWorkspaceTrusted();
    const writableFolder = isWritableFolder(entry.folder);
    const writable = trusted && writableFolder && isWorkspaceSettingsWritable(settings);
    const status = entry.scheduler?.getStatus();
    return {
      status: settings.status,
      settings: settings.settings,
      writable,
      message: !trusted
        ? 'Trust this workspace to let DocBlocks change workspace settings and update catalogs.'
        : !writableFolder
          ? 'This workspace folder is read-only.'
          : settings.message,
      catalog: {
        state: status?.state ?? 'idle',
        message: status?.message ?? null,
        documentCount: status?.result?.documentCount ?? null,
      },
    };
  }
}
