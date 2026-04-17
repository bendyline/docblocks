/**
 * Host bridge — shared types + runtime access for the Electron desktop
 * host. The renderer calls `getDocblocksHost()` to reach the preload
 * contextBridge; `isElectronHost()` gates desktop-only UI branches.
 */

export type {
  DocblocksHostAPI,
  DocblocksHostFsAPI,
  DocblocksHostWorkspacesAPI,
  DocblocksHostShellAPI,
  DocblocksHostFfmpegAPI,
  DocblocksHostUpdaterAPI,
  ElectronWorkspaceInfo,
  HostEnvironment,
  MenuCommand,
  OpenRequest,
  UpdaterStatus,
} from './types.js';

import type { DocblocksHostAPI } from './types.js';

/** True when running inside the Electron desktop shell. */
export function isElectronHost(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const host = (globalThis as { docblocksHost?: unknown }).docblocksHost;
  return (
    typeof host === 'object' &&
    host !== null &&
    typeof (host as { fs?: unknown }).fs === 'object' &&
    (host as { fs?: unknown }).fs !== null
  );
}

/** Return the host API, or throw if not running under Electron. */
export function getDocblocksHost(): DocblocksHostAPI {
  const host = (globalThis as { docblocksHost?: DocblocksHostAPI }).docblocksHost;
  if (!host) {
    throw new Error('docblocksHost is not available — not running under Electron?');
  }
  return host;
}

/** Return the host API, or null if not running under Electron. */
export function maybeGetDocblocksHost(): DocblocksHostAPI | null {
  return (globalThis as { docblocksHost?: DocblocksHostAPI }).docblocksHost ?? null;
}
