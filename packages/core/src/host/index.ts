/**
 * Host bridge — shared types + runtime access for the Electron desktop
 * host. The renderer calls `getDocBlocksHost()` to reach the preload
 * contextBridge; `isElectronHost()` gates desktop-only UI branches.
 */

export type {
  DocBlocksHostAPI,
  DocBlocksHostFsAPI,
  DocBlocksHostExternalAPI,
  DocBlocksHostWorkspacesAPI,
  DocBlocksHostShellAPI,
  DocBlocksHostExportAPI,
  DocBlocksHostFfmpegAPI,
  DocBlocksHostUpdaterAPI,
  DocBlocksHostLifecycleAPI,
  ElectronWorkspaceInfo,
  ExternalBinaryCommitResult,
  HostCloseReason,
  HostEnvironment,
  HostExportTargetGrant,
  HostPrepareCloseRequest,
  HostPrepareCloseResult,
  MenuCommand,
  OpenRequest,
  UpdateInstallResult,
  UpdaterStatus,
} from './types.js';

export type {
  DocBlocksHostGitAPI,
  GitBranchInfo,
  GitCapabilities,
  GitCloneHandle,
  GitCloneProgress,
  GitError,
  GitErrorCode,
  GitFileAtRevision,
  GitFileChange,
  GitFileStatusCode,
  GitLogEntry,
  GitLogOptions,
  GitRemoteInfo,
  GitRepoDetection,
  GitResult,
  GitRevision,
  GitStatus,
} from './git.js';

export {
  ELECTRON_FILE_SYSTEM_V2_CAPABILITIES,
  type DocBlocksHostFsV2API,
  type HostFileSystemV2OpenRequest,
  type HostFileSystemV2Result,
  type HostFileSystemV2WatchMessage,
} from './filesystem-v2.js';

export {
  HOST_WIRE_LIMITS,
  isBoundedBytePayload,
  isBoundedString,
  isTrustedRendererUrl,
  parseExternalHttpUrl,
} from './wire-policy.js';

import type { DocBlocksHostAPI } from './types.js';

/** True when running inside the Electron desktop shell. */
export function isElectronHost(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const host = (globalThis as { docBlocksHost?: unknown }).docBlocksHost;
  return (
    typeof host === 'object' &&
    host !== null &&
    typeof (host as { fs?: unknown }).fs === 'object' &&
    (host as { fs?: unknown }).fs !== null
  );
}

/** Return the host API, or throw if not running under Electron. */
export function getDocBlocksHost(): DocBlocksHostAPI {
  const host = (globalThis as { docBlocksHost?: DocBlocksHostAPI }).docBlocksHost;
  if (!host) {
    throw new Error('docBlocksHost is not available — not running under Electron?');
  }
  return host;
}

/** Return the host API, or null if not running under Electron. */
export function maybeGetDocBlocksHost(): DocBlocksHostAPI | null {
  return (globalThis as { docBlocksHost?: DocBlocksHostAPI }).docBlocksHost ?? null;
}
