import { ELECTRON_FILE_SYSTEM_V2_CAPABILITIES } from '../host/filesystem-v2.js';
import { HostFileSystemProviderV2 } from './host-provider-v2.js';

/** Compatibility entry point retaining the Electron backend's exact guarantees. */
export class ElectronFileSystemProviderV2 extends HostFileSystemProviderV2 {
  public constructor(id: string, label: string, rootPath: string) {
    super(id, label, rootPath, { capabilities: ELECTRON_FILE_SYSTEM_V2_CAPABILITIES });
  }
}
