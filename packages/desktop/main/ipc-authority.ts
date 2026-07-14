import { app, ipcMain } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { isTrustedRendererUrl } from '@bendyline/docblocks/host';

const DEVELOPMENT_RENDERER_ORIGIN = 'http://localhost:5221';

function configuredDevelopmentOrigin(): string | undefined {
  return !app.isPackaged && process.env.NODE_ENV !== 'production'
    ? DEVELOPMENT_RENDERER_ORIGIN
    : undefined;
}

/** Reject subframes and IPC from any page outside the exact renderer origin. */
type PrivilegedIpcEvent = IpcMainEvent | IpcMainInvokeEvent;

export function assertTrustedIpcSender(event: PrivilegedIpcEvent): WebContents {
  const senderFrame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (!senderFrame || !mainFrame || senderFrame !== mainFrame) {
    throw new Error('Privileged IPC is available only to the main renderer frame');
  }
  if (!isTrustedRendererUrl(senderFrame.url, configuredDevelopmentOrigin())) {
    throw new Error('Privileged IPC was rejected for an untrusted renderer origin');
  }
  return event.sender;
}

export function assertIpcArgumentCount(args: readonly unknown[], expected: number): void {
  if (args.length !== expected) throw new Error('Invalid privileged IPC argument count');
}

/** Register one owner/origin-checked invoke boundary with an exact argument shape. */
export function registerTrustedIpcHandler<TArgs extends unknown[], TResult>(
  channel: string,
  expectedArgumentCount: number | readonly number[],
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event);
    const accepted =
      typeof expectedArgumentCount === 'number'
        ? args.length === expectedArgumentCount
        : expectedArgumentCount.includes(args.length);
    if (!accepted) throw new Error('Invalid privileged IPC argument count');
    return handler(event, ...(args as TArgs));
  });
}
