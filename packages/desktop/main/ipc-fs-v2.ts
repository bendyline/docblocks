import { ipcMain, type WebContents } from 'electron';
import type {
  FileSystemCreateDirectoryOptions,
  FileSystemMoveOptions,
  FileSystemRemoveOptions,
  FileSystemWriteOptions,
  WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import type { HostFileSystemV2OpenRequest } from '@bendyline/docblocks/host';

import { FileSystemV2IpcService } from './filesystem-v2-ipc-service.js';

export function registerFsV2Ipc(service = new FileSystemV2IpcService()): void {
  const owners = new Map<number, { sender: WebContents; onDestroyed: () => void }>();

  const owner = (sender: WebContents): string => {
    if (!owners.has(sender.id)) {
      const onDestroyed = () => {
        owners.delete(sender.id);
        void service.disposeOwner(String(sender.id));
      };
      owners.set(sender.id, { sender, onDestroyed });
      sender.once('destroyed', onDestroyed);
    }
    return String(sender.id);
  };

  ipcMain.handle('fs:v2:open', (event, request: HostFileSystemV2OpenRequest) =>
    service.open(owner(event.sender), request),
  );
  ipcMain.handle('fs:v2:stat', (event, instanceId: string, itemPath: WorkspacePath) =>
    service.stat(owner(event.sender), instanceId, itemPath),
  );
  ipcMain.handle('fs:v2:readFile', (event, instanceId: string, itemPath: WorkspacePath) =>
    service.readFile(owner(event.sender), instanceId, itemPath),
  );
  ipcMain.handle('fs:v2:readDirectory', (event, instanceId: string, itemPath: WorkspacePath) =>
    service.readDirectory(owner(event.sender), instanceId, itemPath),
  );
  ipcMain.handle(
    'fs:v2:writeFile',
    (
      event,
      instanceId: string,
      itemPath: WorkspacePath,
      data: ArrayBuffer | Uint8Array,
      options?: FileSystemWriteOptions,
    ) => service.writeFile(owner(event.sender), instanceId, itemPath, data, options),
  );
  ipcMain.handle(
    'fs:v2:createDirectory',
    (
      event,
      instanceId: string,
      itemPath: WorkspacePath,
      options?: FileSystemCreateDirectoryOptions,
    ) => service.createDirectory(owner(event.sender), instanceId, itemPath, options),
  );
  ipcMain.handle(
    'fs:v2:remove',
    (event, instanceId: string, itemPath: WorkspacePath, options?: FileSystemRemoveOptions) =>
      service.remove(owner(event.sender), instanceId, itemPath, options),
  );
  ipcMain.handle(
    'fs:v2:move',
    (
      event,
      instanceId: string,
      oldPath: WorkspacePath,
      newPath: WorkspacePath,
      options?: FileSystemMoveOptions,
    ) => service.move(owner(event.sender), instanceId, oldPath, newPath, options),
  );
  ipcMain.handle('fs:v2:snapshot', (event, instanceId: string) =>
    service.snapshot(owner(event.sender), instanceId),
  );
  ipcMain.handle('fs:v2:watchSubscribe', (event, instanceId: string, subscriptionId: string) => {
    const sender = event.sender;
    return service.watchSubscribe(owner(sender), instanceId, subscriptionId, (message) => {
      if (!sender.isDestroyed()) sender.send('fs:v2:watchMessage', message);
    });
  });
  ipcMain.handle('fs:v2:watchUnsubscribe', (event, instanceId: string, subscriptionId: string) =>
    service.watchUnsubscribe(owner(event.sender), instanceId, subscriptionId),
  );
  ipcMain.handle('fs:v2:dispose', (event, instanceId: string) =>
    service.dispose(owner(event.sender), instanceId),
  );
}
