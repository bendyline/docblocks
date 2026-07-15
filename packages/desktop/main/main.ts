/**
 * Electron main process — window, custom protocol, IPC bootstrap.
 *
 * The renderer is served from a custom `app://` protocol (not file://)
 * so Monaco workers, dynamic imports, and the IndexedDB origin remain
 * stable across updates.
 */

import { app, BrowserWindow, dialog, protocol, screen, shell, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import windowStateKeeper from 'electron-window-state';
import { isTrustedRendererUrl, parseExternalHttpUrl } from '@bendyline/docblocks/host';

import { registerFsIpc } from './ipc-fs.js';
import { registerFsV2Ipc } from './ipc-fs-v2.js';
import { registerExternalIpc } from './ipc-external.js';
import { ensureDevelopmentWorkspace, registerWorkspaceIpc } from './ipc-workspaces.js';
import { registerShellIpc } from './ipc-shell.js';
import { registerExportIpc } from './ipc-export.js';
import { registerFfmpegIpc } from './ipc-ffmpeg.js';
import { registerGitIpc } from './ipc-git.js';
import { killAllGitChildren } from './git/exec.js';
import { registerUpdaterIpc, initAutoUpdater, isStoreBuild } from './updater.js';
import { buildMenu } from './menu.js';
import {
  readSettings,
  updateSettings,
  flushSettings,
  takeSettingsRecovery,
  settingsFilePath,
  type SettingsRecovery,
} from './settings.js';
import { getWorkspaceRoots, isPathInside } from './workspace-roots.js';
import { repairWorkspaceIdentities } from './workspace-id.js';
import { handleOpenFileArg, handleOpenUrl } from './open-requests.js';
import { PendingOpenRequests } from './pending-open-requests.js';
import { registerTray } from './tray.js';
import { startAccessingBookmark, releaseAllScopedResources } from './security-scoped.js';
import {
  attachWindowCloseGuard,
  prepareWindowsForExit,
  registerWindowLifecycleIpc,
} from './window-lifecycle.js';
import { developmentUserDataPath, isDevelopmentRuntime } from './development-runtime.js';

const DEV_SERVER_URL = 'http://localhost:5221';
const TITLE_BAR_HEIGHT = 32;
const isDev = isDevelopmentRuntime(app.isPackaged, process.env.NODE_ENV);
const isAutomation = Boolean(process.env.DOCBLOCKS_E2E_DEFAULT_ROOT);

// Development must not share Chromium storage, settings, window state, or the
// single-instance lock with an installed DocBlocks build. Honour an explicit
// command-line profile so automation and one-off debugging can remain isolated.
if (isDev && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', developmentUserDataPath(app.getPath('appData')));
}

// Some headless/virtualized Windows environments cannot start Chromium's GPU
// subprocess (0xC0000135). This must run before app.ready; E2E sets the flag so
// a driver/runtime failure becomes a test failure instead of a native crash.
if (process.env.DOCBLOCKS_DISABLE_HARDWARE_ACCELERATION === '1') {
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null = null;
let appExitApproved = false;
let appExitPreparing = false;
const pendingOpenRequests = new PendingOpenRequests();

function drainPendingOpenRequests(win: BrowserWindow): void {
  pendingOpenRequests.drain((request) => {
    if (request.kind === 'url') handleOpenUrl(win, request.url);
    else if (request.kind === 'file') handleOpenFileArg(win, [request.path]);
    else handleOpenFileArg(win, request.argv);
  });
}

// Single-instance lock — second launches forward their argv to the first
// so Windows "Open With" and docblocks:// deep links route to the same window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // `app.quit()` is asynchronous, so a losing instance keeps executing. The
  // ready bootstrap below is therefore gated on the lock: without that gate a
  // second launch races its own quit and can still reach createWindow(),
  // registering duplicate IPC handlers and flashing a stray window. (A plain
  // `return` here is not available — this is an ES module, not a CJS wrapper.)
  app.quit();
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    handleOpenFileArg(mainWindow, argv);
  } else {
    // A second launch can arrive after the primary acquired its lock but
    // before createWindow assigned mainWindow. Preserve the complete argv so
    // launch-file authority is not lost in that narrow startup interval.
    pendingOpenRequests.enqueueArgv(argv);
  }
});

// macOS deep-link / open-with delivery.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    handleOpenFileArg(mainWindow, [filePath]);
  } else {
    // Queue until the window is ready.
    pendingOpenRequests.enqueueFile(filePath);
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    handleOpenUrl(mainWindow, url);
  } else {
    pendingOpenRequests.enqueueUrl(url);
  }
});

// Register docblocks:// as a deep-link protocol handler (also declared in electron-builder.yml).
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('docblocks', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('docblocks');
}

// Privileged schemes must be registered before app.ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function registerAppProtocol() {
  const rendererRoot = path.join(__dirname, '..', 'renderer');
  protocol.handle('app', async (request) => {
    // The protocol is registered by scheme, so Electron invokes this handler
    // for app://<any-host>. Only the canonical renderer host is authoritative.
    if (!isTrustedRendererUrl(request.url)) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(request.url);
    // Strip the leading slash and resolve inside the renderer directory.
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (rel.includes('\0')) {
      return new Response('Bad request', { status: 400 });
    }
    if (!rel || rel.endsWith('/')) rel = path.join(rel, 'index.html');

    const target = path.join(rendererRoot, rel);
    // Prevent traversal outside the renderer root.
    const resolved = path.resolve(target);
    if (!isPathInside(rendererRoot, resolved)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(resolved)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

/**
 * Cross-check saved window bounds against the current display layout.
 * If the monitor the user last docked against is gone (laptop unplugged
 * from external display), fall back to centered defaults — otherwise
 * `electron-window-state` happily restores a window positioned entirely
 * off-screen where the user can't find it.
 */
function boundsAreVisible(bounds: {
  x?: number;
  y?: number;
  width: number;
  height: number;
}): boolean {
  if (bounds.x === undefined || bounds.y === undefined) return false;
  const b = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  return screen.getAllDisplays().some((display) => {
    const d = display.workArea;
    const overlap =
      b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y;
    return overlap;
  });
}

async function createWindow(startupWorkspaceId?: string): Promise<BrowserWindow> {
  const winState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800,
  });

  const useSaved = boundsAreVisible({
    x: winState.x,
    y: winState.y,
    width: winState.width,
    height: winState.height,
  });

  const preloadPath = path.join(__dirname, '..', 'preload', 'preload.cjs');

  const win = new BrowserWindow({
    x: useSaved ? winState.x : undefined,
    y: useSaved ? winState.y : undefined,
    width: useSaved ? winState.width : 1280,
    height: useSaved ? winState.height : 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'DocBlocks',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#6b7280',
      height: TITLE_BAR_HEIGHT,
    },
    center: !useSaved,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // The preload uses only Electron's sandbox-supported bridge APIs.
      sandbox: true,
      webSecurity: true,
    },
  });

  winState.manage(win);
  attachWindowCloseGuard(win);

  if (isAutomation) {
    win.webContents.on('render-process-gone', (_event, details) => {
      process.stderr.write(
        `[docblocks:e2e] renderer gone: reason=${details.reason} exitCode=${details.exitCode}\n`,
      );
    });
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // A popup never inherits renderer authority. Only canonical HTTP(S) URLs may
  // leave the app, and they always open in the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = parseExternalHttpUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl).catch(() => undefined);
    }
    return { action: 'deny' };
  });

  const developmentOrigin = isDev ? DEV_SERVER_URL : undefined;
  const preventUntrustedNavigation = (event: { preventDefault(): void }, url: string) => {
    if (!isTrustedRendererUrl(url, developmentOrigin)) {
      event.preventDefault();
    }
  };

  win.webContents.on('will-navigate', (event, url) => {
    preventUntrustedNavigation(event, url);
  });

  // Server redirects are a distinct Electron event and otherwise bypass the
  // initial navigation decision.
  win.webContents.on('will-redirect', (event, url) => {
    preventUntrustedNavigation(event, url);
  });

  win.once('ready-to-show', () => {
    win.show();
    // Drain any pending open requests received before the window existed.
    drainPendingOpenRequests(win);
    handleOpenFileArg(win, process.argv);
  });

  if (isDev) {
    const developmentUrl = new URL(DEV_SERVER_URL);
    if (startupWorkspaceId) developmentUrl.hash = encodeURIComponent(startupWorkspaceId);
    await win.loadURL(developmentUrl.toString());
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadURL('app://docblocks/index.html');
  }

  return win;
}

async function prepareApplicationExit(reason: 'app-quit' | 'update-install'): Promise<boolean> {
  if (appExitApproved) return true;
  const prepared = await prepareWindowsForExit(BrowserWindow.getAllWindows(), reason);
  if (!prepared) return false;

  // Settings are not part of the active document transaction, but they still
  // need to reach disk before Electron tears down the process.
  try {
    await flushSettings();
  } catch {
    // Best effort: a settings failure must not strand a document that was
    // already durably committed and acknowledged by every renderer.
  }

  killAllGitChildren();
  releaseAllScopedResources();
  appExitApproved = true;
  return true;
}

/**
 * Tell the user their settings were abandoned, and where the original went.
 *
 * Presented after the window exists so the warning is a sheet on DocBlocks
 * rather than a bare alert in front of nothing, and deliberately not awaited —
 * a modal the user leaves sitting must not hold up the rest of startup.
 */
function reportSettingsRecovery(win: BrowserWindow, recovery: SettingsRecovery): void {
  const detail =
    recovery.kind === 'unreadable'
      ? [
          'DocBlocks could not read its settings file, so this session started with default settings.',
          'Your settings file has been left untouched — if the problem was temporary, restarting DocBlocks should restore it. Any change you make now will overwrite it.',
          `Location: ${settingsFilePath()}`,
          `Reason: ${recovery.reason}`,
        ]
      : [
          'DocBlocks could not understand its settings file, so this session started with default settings. Your documents are not affected, but registered workspaces may need to be opened again.',
          recovery.quarantinePath
            ? `The original file was not deleted — it was moved to:\n${recovery.quarantinePath}`
            : `The original file could not be moved aside (${recovery.quarantineFailure ?? 'unknown error'}), so it may be overwritten by the next settings change.\nLocation: ${settingsFilePath()}`,
          `Reason: ${recovery.reason}`,
        ];

  void dialog
    .showMessageBox(win, {
      type: 'warning',
      buttons: ['Continue'],
      defaultId: 0,
      title: 'DocBlocks settings were reset',
      message: 'DocBlocks started with default settings.',
      detail: detail.join('\n\n'),
    })
    .catch(() => undefined);
}

/**
 * Last stop for a startup failure. Reaching here means no window exists and
 * none is coming, so the only honest outcomes are to say so and leave.
 */
function reportFatalStartupFailure(error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // showErrorBox is the one dialog API that works with no owner window and no
  // event loop assumptions — the rest of this package's dialog usage is modal
  // on a window that, by definition, does not exist here.
  dialog.showErrorBox(
    'DocBlocks could not start',
    `DocBlocks failed during startup and has to close.\n\n${message}`,
  );
  // Not app.quit(): that fires `before-quit`, which preventDefaults and awaits
  // window/settings teardown this bootstrap may never have set up — a hang on
  // top of a crash. exit() is the truthful response to an unusable process.
  app.exit(1);
}

async function bootstrap(): Promise<void> {
  // Restrict permissions by default.
  const session = (await import('electron')).session;
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  // Strict CSP on the renderer.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          isDev
            ? "default-src 'self' app: http://localhost:5221 ws://localhost:5221; " +
              "script-src 'self' app: http://localhost:5221 'unsafe-inline' 'unsafe-eval'; " +
              "style-src 'self' app: http://localhost:5221 'unsafe-inline'; " +
              "img-src 'self' app: http://localhost:5221 data: blob:; " +
              "font-src 'self' app: http://localhost:5221 data:; " +
              "connect-src 'self' app: http://localhost:5221 ws://localhost:5221; " +
              "worker-src 'self' app: http://localhost:5221 blob:; " +
              "object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none';"
            : "default-src 'self' app:; " +
              "script-src 'self' app:; " +
              "style-src 'self' app: 'unsafe-inline'; " +
              "img-src 'self' app: data: blob:; " +
              "font-src 'self' app: data:; " +
              "connect-src 'self' app:; " +
              "worker-src 'self' app: blob:; " +
              "object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none';",
        ],
      },
    });
  });

  registerAppProtocol();

  // Pre-populate the whitelist with any previously trusted roots from settings.
  // In a MAS build, re-open security-scoped access from the saved bookmark
  // BEFORE registering — otherwise the sandbox denies node:fs on that path.
  // startAccessingBookmark is a no-op outside MAS, so this is inert elsewhere.
  // A broken settings file yields defaults here rather than throwing: losing
  // saved workspaces is recoverable, launching to no window at all is not.
  let settings = await readSettings();
  const settingsRecovery = takeSettingsRecovery();
  const roots = getWorkspaceRoots();
  for (const info of settings.workspaces) {
    startAccessingBookmark(info.bookmark);
  }
  const canonicalWorkspaces = settings.workspaces.map((workspace) => {
    const resolved = path.resolve(workspace.rootPath);
    let rootPath = resolved;
    try {
      rootPath = fs.realpathSync.native(resolved);
    } catch {
      // Offline persisted roots remain registered lexically and fail closed
      // when a filesystem operation later attempts physical resolution.
    }
    return rootPath === workspace.rootPath ? workspace : { ...workspace, rootPath };
  });
  const canonicalized = canonicalWorkspaces.some(
    (workspace, index) => workspace !== settings.workspaces[index],
  );
  const repairedWorkspaces = repairWorkspaceIdentities(canonicalWorkspaces);
  if (canonicalized || repairedWorkspaces.changed) {
    settings = await updateSettings((current) => ({
      ...current,
      workspaces: repairedWorkspaces.records,
    }));
  }
  for (const info of settings.workspaces) {
    roots.register(info.id, info.rootPath);
  }

  registerFsIpc();
  registerFsV2Ipc();
  registerExternalIpc();
  registerWorkspaceIpc();
  registerShellIpc();
  registerExportIpc();
  registerFfmpegIpc();
  registerGitIpc();
  registerWindowLifecycleIpc();
  registerUpdaterIpc(() => prepareApplicationExit('update-install'));

  // A source checkout always starts on its dedicated development workspace.
  // The URL hash intentionally wins over renderer last-document state, while
  // OS open-file/deep-link requests still supersede it through the normal
  // launch-request generation path.
  const developmentWorkspace = isDev ? await ensureDevelopmentWorkspace() : undefined;
  mainWindow = await createWindow(developmentWorkspace?.id);
  // `ready-to-show` can precede the `createWindow()` continuation. Close the
  // narrow interval where an OS event still observed `mainWindow === null`
  // after the first drain and therefore queued one late request.
  drainPendingOpenRequests(mainWindow);

  buildMenu(mainWindow);
  mainWindow.setMenuBarVisibility(false);

  registerTray(() => mainWindow);

  if (settingsRecovery) reportSettingsRecovery(mainWindow, settingsRecovery);

  // Store builds (Mac App Store / Microsoft Store) must not self-update — the
  // store delivers updates. Only run the GitHub updater for direct-download builds.
  if (!isDev && !isStoreBuild()) {
    initAutoUpdater();
  }
}

if (gotLock) {
  // Without this catch V8 swallows any rejection from the bootstrap and the
  // user is left staring at a running process with no window and no error.
  // Scoped deliberately to the ready path rather than a blanket
  // process-level handler: registering `process.on('unhandledRejection')`
  // *suppresses* Node's default handling, which would silently downgrade every
  // future hard failure in the app to a log line nobody reads.
  app.whenReady().then(bootstrap).catch(reportFatalStartupFailure);
}

app.on('before-quit', (event) => {
  if (appExitApproved) return;
  event.preventDefault();
  if (appExitPreparing) return;
  appExitPreparing = true;
  void prepareApplicationExit('app-quit').then(
    (prepared) => {
      appExitPreparing = false;
      if (prepared) app.quit();
    },
    () => {
      appExitPreparing = false;
    },
  );
});

app.on('window-all-closed', () => {
  // Normal macOS apps remain active after their final window closes. Test
  // processes must instead terminate deterministically; otherwise a launch
  // failure can leave a headless Electron process (and Playwright worker)
  // alive indefinitely.
  if (process.platform !== 'darwin' || isAutomation) {
    app.quit();
  }
});

async function reopenWindow(): Promise<void> {
  const developmentWorkspace = isDev ? await ensureDevelopmentWorkspace() : undefined;
  mainWindow = await createWindow(developmentWorkspace?.id);
  drainPendingOpenRequests(mainWindow);
  buildMenu(mainWindow);
  mainWindow.setMenuBarVisibility(false);
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length !== 0) return;
  // Same failure mode as the ready path: an async listener's rejection is
  // unhandled, so a failure to reopen would leave the user clicking the dock
  // icon of a live, windowless app. Unlike startup this is not fatal — the
  // process is otherwise healthy — so report and stay up.
  void reopenWindow().catch((error: unknown) => {
    dialog.showErrorBox(
      'DocBlocks could not open a window',
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  });
});

// Silence unused import warning for fileURLToPath — kept for future use.
void fileURLToPath;
