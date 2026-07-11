import { randomUUID } from 'node:crypto';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import type {
  HostCloseReason,
  HostPrepareCloseRequest,
  HostPrepareCloseResult,
} from '@bendyline/docblocks/host';

const DEFAULT_PREPARE_TIMEOUT_MS = 15_000;

interface PrepareClosePayload {
  requestId: string;
  result: HostPrepareCloseResult;
}

interface PendingPreparation {
  requestId: string;
  webContentsId: number;
  win: BrowserWindow;
  resolve(result: HostPrepareCloseResult): void;
  timer: ReturnType<typeof setTimeout>;
  onClosed(): void;
}

const pendingByRequest = new Map<string, PendingPreparation>();
const pendingByWindow = new WeakMap<BrowserWindow, Promise<HostPrepareCloseResult>>();
const preparedRequestByWindow = new WeakMap<BrowserWindow, string>();
const approvedWindows = new WeakSet<BrowserWindow>();
const closingWindows = new WeakSet<BrowserWindow>();
let ipcRegistered = false;

export function registerWindowLifecycleIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.on('lifecycle:prepare-close-result', (event, payload: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) return;
    if (!isPrepareClosePayload(payload)) return;
    const pending = pendingByRequest.get(payload.requestId);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    settlePending(pending, payload.result);
  });
}

export function attachWindowCloseGuard(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (approvedWindows.has(win) || win.isDestroyed()) return;
    event.preventDefault();
    if (closingWindows.has(win)) return;
    closingWindows.add(win);
    void closeWindowWithPreparation(win).finally(() => closingWindows.delete(win));
  });
  win.on('closed', () => {
    const requestId = preparedRequestByWindow.get(win);
    if (requestId) preparedRequestByWindow.delete(win);
  });
}

export function approveWindowClose(win: BrowserWindow): void {
  approvedWindows.add(win);
}

export function cancelPreparedWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const requestId = preparedRequestByWindow.get(win);
  if (!requestId) return;
  preparedRequestByWindow.delete(win);
  try {
    win.webContents.send('lifecycle:cancel-close', requestId);
  } catch {
    // The renderer disappeared while cancellation was being delivered.
  }
}

export async function prepareWindowsForExit(
  windows: BrowserWindow[],
  reason: Exclude<HostCloseReason, 'window-close'>,
): Promise<boolean> {
  const liveWindows = windows.filter((win) => !win.isDestroyed());
  if (liveWindows.length === 0) return true;

  while (true) {
    const results = await Promise.all(
      liveWindows.map(async (win) => ({
        win,
        result: await prepareWindow(win, reason),
      })),
    );
    if (results.every(({ result }) => result.status === 'ready')) {
      for (const { win } of results) approveWindowClose(win);
      return true;
    }

    const blocked = results.find(({ result }) => result.status === 'blocked');
    const detail =
      blocked?.result.status === 'blocked'
        ? blocked.result.message
        : 'DocBlocks could not confirm that every document is saved.';
    const response = await showCloseFailureDialog(liveWindows[0], actionLabel(reason), detail);
    if (response === 0) {
      for (const { win } of results) cancelPreparedWindow(win);
      continue;
    }
    if (response === 1) {
      for (const { win } of results) cancelPreparedWindow(win);
      return false;
    }

    for (const { win } of results) approveWindowClose(win);
    return true;
  }
}

/**
 * Reloading a webContents destroys the renderer just as surely as closing its
 * window. Route both menu reload variants through the same save handshake.
 */
export async function reloadWindowWithPreparation(
  win: BrowserWindow,
  ignoreCache = false,
): Promise<boolean> {
  const reason: HostCloseReason = ignoreCache ? 'force-reload' : 'reload';
  while (!win.isDestroyed()) {
    const result = await prepareWindow(win, reason);
    if (result.status === 'ready') {
      preparedRequestByWindow.delete(win);
      if (ignoreCache) win.webContents.reloadIgnoringCache();
      else win.reload();
      return true;
    }

    const response = await showCloseFailureDialog(win, 'Reload', result.message);
    if (response === 0) continue;
    if (response === 1) {
      cancelPreparedWindow(win);
      return false;
    }

    preparedRequestByWindow.delete(win);
    if (ignoreCache) win.webContents.reloadIgnoringCache();
    else win.reload();
    return true;
  }
  return false;
}

export function prepareWindow(
  win: BrowserWindow,
  reason: HostCloseReason,
  timeoutMs = DEFAULT_PREPARE_TIMEOUT_MS,
): Promise<HostPrepareCloseResult> {
  if (win.isDestroyed()) {
    return Promise.resolve({ status: 'ready', persistedRevision: 0 });
  }
  const existing = pendingByWindow.get(win);
  if (existing) return existing;

  const requestId = randomUUID();
  const request: HostPrepareCloseRequest = {
    requestId,
    reason,
    deadline: Date.now() + timeoutMs,
  };
  const promise = new Promise<HostPrepareCloseResult>((resolve) => {
    const onClosed = () => {
      const pending = pendingByRequest.get(requestId);
      if (!pending) return;
      settlePending(pending, {
        status: 'blocked',
        code: 'not-ready',
        message: 'The editor window closed before it acknowledged the save.',
      });
    };
    const timer = setTimeout(() => {
      const pending = pendingByRequest.get(requestId);
      if (!pending) return;
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('lifecycle:cancel-close', requestId);
        } catch {
          // The blocked result below is still delivered to the main flow.
        }
      }
      settlePending(pending, {
        status: 'blocked',
        code: 'not-ready',
        message: 'Timed out while waiting for the document to save.',
      });
    }, timeoutMs);
    const pending: PendingPreparation = {
      requestId,
      webContentsId: win.webContents.id,
      win,
      resolve,
      timer,
      onClosed,
    };
    pendingByRequest.set(requestId, pending);
    win.once('closed', onClosed);
    try {
      win.webContents.send('lifecycle:prepare-close', request);
    } catch {
      settlePending(pending, {
        status: 'blocked',
        code: 'not-ready',
        message: 'The editor renderer was not available to acknowledge the save.',
      });
    }
  });

  pendingByWindow.set(win, promise);
  void promise.then(
    (result) => {
      pendingByWindow.delete(win);
      if (result.status === 'ready') preparedRequestByWindow.set(win, requestId);
    },
    () => pendingByWindow.delete(win),
  );
  return promise;
}

async function closeWindowWithPreparation(win: BrowserWindow): Promise<void> {
  while (!win.isDestroyed()) {
    const result = await prepareWindow(win, 'window-close');
    if (result.status === 'ready') {
      approveWindowClose(win);
      win.close();
      return;
    }

    const response = await showCloseFailureDialog(win, 'Close', result.message);
    if (response === 0) continue;
    if (response === 1) {
      cancelPreparedWindow(win);
      return;
    }
    approveWindowClose(win);
    win.close();
    return;
  }
}

function settlePending(pending: PendingPreparation, result: HostPrepareCloseResult): void {
  pendingByRequest.delete(pending.requestId);
  clearTimeout(pending.timer);
  pending.win.removeListener('closed', pending.onClosed);
  pending.resolve(result);
}

async function showCloseFailureDialog(
  win: BrowserWindow,
  action: string,
  detail: string,
): Promise<number> {
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Document not saved',
    message: 'DocBlocks could not finish saving the active document.',
    detail,
    buttons: ['Retry Save', 'Cancel', action + ' Without Saving'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return result.response;
}

function actionLabel(reason: HostCloseReason): string {
  switch (reason) {
    case 'update-install':
      return 'Restart';
    case 'reload':
    case 'force-reload':
      return 'Reload';
    default:
      return 'Quit';
  }
}

function isPrepareClosePayload(value: unknown): value is PrepareClosePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<PrepareClosePayload>;
  if (typeof payload.requestId !== 'string' || payload.requestId.length > 100) return false;
  return isPrepareCloseResult(payload.result);
}

function isPrepareCloseResult(value: unknown): value is HostPrepareCloseResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<HostPrepareCloseResult>;
  if (result.status === 'ready') {
    return (
      typeof result.persistedRevision === 'number' &&
      Number.isSafeInteger(result.persistedRevision) &&
      result.persistedRevision >= 0
    );
  }
  if (result.status !== 'blocked') return false;
  return (
    (result.code === 'save-failed' ||
      result.code === 'external-conflict' ||
      result.code === 'not-ready') &&
    typeof result.message === 'string' &&
    result.message.length <= 2_000
  );
}
