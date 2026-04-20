/**
 * Electron main process — window, custom protocol, IPC bootstrap.
 *
 * The renderer is served from a custom `app://` protocol (not file://)
 * so Monaco workers, dynamic imports, and the IndexedDB origin remain
 * stable across updates.
 */

import { app, BrowserWindow, protocol, screen, shell, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import windowStateKeeper from 'electron-window-state';

import { registerFsIpc } from './ipc-fs.js';
import { registerWorkspaceIpc } from './ipc-workspaces.js';
import { registerShellIpc } from './ipc-shell.js';
import { registerFfmpegIpc } from './ipc-ffmpeg.js';
import { registerUpdaterIpc, initAutoUpdater } from './updater.js';
import { buildMenu } from './menu.js';
import { readSettings, flushSettings } from './settings.js';
import { getWorkspaceRoots } from './workspace-roots.js';
import { handleOpenFileArg } from './open-requests.js';
import { registerTray } from './tray.js';

const DEV_SERVER_URL = 'http://localhost:5221';
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

let mainWindow: BrowserWindow | null = null;

// Single-instance lock — second launches forward their argv to the first
// so Windows "Open With" and docblocks:// deep links route to the same window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    handleOpenFileArg(mainWindow, argv);
  }
});

// macOS deep-link / open-with delivery.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    handleOpenFileArg(mainWindow, [filePath]);
  } else {
    // Queue until the window is ready.
    pendingOpenPaths.push(filePath);
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('open-request', { url });
  } else {
    pendingOpenUrls.push(url);
  }
});

const pendingOpenPaths: string[] = [];
const pendingOpenUrls: string[] = [];

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
    const url = new URL(request.url);
    // Strip the leading slash and resolve inside the renderer directory.
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel = path.join(rel, 'index.html');

    const target = path.join(rendererRoot, rel);
    // Prevent traversal outside the renderer root.
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(rendererRoot))) {
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

async function createWindow(): Promise<BrowserWindow> {
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
    center: !useSaved,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node APIs; renderer stays isolated
      webSecurity: true,
    },
  });

  winState.manage(win);

  // Block all non-app:// navigation; open external URLs in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.protocol !== 'app:' && url !== DEV_SERVER_URL) {
      event.preventDefault();
      shell.openExternal(url).catch(() => undefined);
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    // Drain any pending open requests received before the window existed.
    while (pendingOpenPaths.length) {
      const p = pendingOpenPaths.shift()!;
      handleOpenFileArg(win, [p]);
    }
    while (pendingOpenUrls.length) {
      const u = pendingOpenUrls.shift()!;
      win.webContents.send('open-request', { url: u });
    }
    handleOpenFileArg(win, process.argv);
  });

  if (isDev) {
    await win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadURL('app://docblocks/index.html');
  }

  return win;
}

app.whenReady().then(async () => {
  // Restrict permissions by default.
  const session = (await import('electron')).session;
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

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
              "connect-src 'self' app: http://localhost:5221 ws://localhost:5221 https:; " +
              "worker-src 'self' app: http://localhost:5221 blob:; " +
              "object-src 'none';"
            : "default-src 'self' app:; " +
              "script-src 'self' app:; " +
              "style-src 'self' app: 'unsafe-inline'; " +
              "img-src 'self' app: data: blob:; " +
              "font-src 'self' app: data:; " +
              "connect-src 'self' app: https:; " +
              "worker-src 'self' app: blob:; " +
              "object-src 'none';",
        ],
      },
    });
  });

  registerAppProtocol();

  // Pre-populate the whitelist with any previously trusted roots from settings.
  const settings = await readSettings();
  const roots = getWorkspaceRoots();
  for (const info of settings.workspaces) {
    roots.register(info.id, info.rootPath);
  }

  registerFsIpc();
  registerWorkspaceIpc();
  registerShellIpc();
  registerFfmpegIpc();
  registerUpdaterIpc();

  mainWindow = await createWindow();

  buildMenu(mainWindow);

  registerTray(() => mainWindow);

  if (!isDev) {
    initAutoUpdater();
  }
});

app.on('before-quit', async (event) => {
  // Give the debounced settings writer a chance to flush pending changes
  // before the process exits. If flush is still pending we briefly defer
  // quit, commit, then retrigger. Guard against re-entry.
  if ((app as unknown as { _flushedSettings?: boolean })._flushedSettings) return;
  event.preventDefault();
  try {
    await flushSettings();
  } catch {
    // best-effort — never block shutdown on an I/O error
  }
  (app as unknown as { _flushedSettings?: boolean })._flushedSettings = true;
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = await createWindow();
    buildMenu(mainWindow);
  }
});

// Silence unused import warning for fileURLToPath — kept for future use.
void fileURLToPath;
