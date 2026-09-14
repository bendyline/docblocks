/**
 * Host bridge — shared types + runtime access for the Electron desktop
 * host. The renderer calls `getDocBlocksHost()` to reach the preload
 * contextBridge; `isElectronHost()` gates desktop-only UI branches.
 */

export {
  HOST_PLATFORMS,
  HOST_SURFACE_KINDS,
  NO_HOST_CAPABILITIES,
  deriveHostCapabilities,
  parseHostEnvironment,
} from './capabilities.js';
export type { HostCapabilities, HostPlatform, HostSurfaceKind } from './capabilities.js';

export type {
  DocBlocksHostAPI,
  DocBlocksHostFsAPI,
  DocBlocksHostExternalAPI,
  DocBlocksHostWorkspacesAPI,
  DocBlocksHostShellAPI,
  DocBlocksHostClipboardAPI,
  DocBlocksHostExportAPI,
  DocBlocksHostFfmpegAPI,
  DocBlocksHostUpdaterAPI,
  DocBlocksHostLifecycleAPI,
  DocBlocksHostMenuAPI,
  HostPinnedDocument,
  ElectronWorkspaceInfo,
  ExternalBinaryCommitResult,
  HostCloseReason,
  HostEnvironment,
  HostExportTargetGrant,
  HostPrepareCloseRequest,
  HostPrepareCloseResult,
  MenuCommand,
  OpenRequest,
  UpdateCheckResult,
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
  FILE_SYSTEM_TRANSFER_LIMITS,
  type HostFileSystemReadTransfer,
  type DocBlocksHostFsV2API,
  type HostFileSystemV2OpenRequest,
  type HostFileSystemV2Result,
  type HostFileSystemV2WatchMessage,
} from './filesystem-v2.js';

export {
  HOST_WIRE_LIMITS,
  MAX_HOST_PINNED_DOCUMENTS,
  isBoundedBytePayload,
  isBoundedString,
  isTrustedRendererUrl,
  parseExternalHttpUrl,
  parseOpenRequest,
  parsePinnedMenuDocuments,
} from './wire-policy.js';

import type { DocBlocksHostAPI, HostEnvironment } from './types.js';
import {
  NO_HOST_CAPABILITIES,
  deriveHostCapabilities,
  parseHostEnvironment,
  type HostCapabilities,
} from './capabilities.js';

function rawHost(): unknown {
  if (typeof globalThis === 'undefined') return null;
  return (globalThis as { docBlocksHost?: unknown }).docBlocksHost ?? null;
}

/** True when any privileged host bridge is installed. */
export function hasDocBlocksHost(): boolean {
  return deriveHostCapabilities(rawHost()) !== NO_HOST_CAPABILITIES;
}

/**
 * What the installed host can do. All-false when there is no host, so callers
 * never need a null check before asking.
 */
export function getHostCapabilities(): HostCapabilities {
  return deriveHostCapabilities(rawHost());
}

/** Ask one capability question. The replacement for `isElectronHost()`. */
export function hostSupports(capability: keyof HostCapabilities): boolean {
  return getHostCapabilities()[capability];
}

/** The parsed host environment, or null when there is no trustworthy host. */
export function getHostEnvironment(): HostEnvironment | null {
  const host = rawHost();
  if (typeof host !== 'object' || host === null) return null;
  return parseHostEnvironment((host as { env?: unknown }).env);
}

/**
 * @deprecated Ask a capability with `hostSupports(...)` instead. This conflated
 * a dozen unrelated decisions into one boolean that no non-Electron host can
 * answer honestly. Retained only until the last caller is migrated.
 */
export function isElectronHost(): boolean {
  return getHostEnvironment()?.surface === 'electron';
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
