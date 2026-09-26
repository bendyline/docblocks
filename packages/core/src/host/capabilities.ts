import { HOST_WIRE_LIMITS, isBoundedString } from './wire-policy.js';
import type { HostEnvironment } from './types.js';

/**
 * Which shell installed the bridge.
 *
 * This is an identity question, and almost nothing should be asking it — ask a
 * capability instead. It exists for the handful of places that genuinely differ
 * by product rather than by ability, such as which documentation URL to open.
 */
export type HostSurfaceKind = 'electron' | 'capacitor';

export type HostPlatform = 'darwin' | 'win32' | 'linux' | 'ios' | 'android';

export const HOST_SURFACE_KINDS: readonly HostSurfaceKind[] = Object.freeze([
  'electron',
  'capacitor',
]);

export const HOST_PLATFORMS: readonly HostPlatform[] = Object.freeze([
  'darwin',
  'win32',
  'linux',
  'ios',
  'android',
]);

/**
 * What the installed host can actually do.
 *
 * Every member is a question a caller genuinely asks. None is a proxy for
 * "which shell is this" — that was the failure of `isElectronHost()`, which
 * stood in for a dozen unrelated decisions and which no mobile host could
 * answer honestly either way.
 */
export interface HostCapabilities {
  /** The host owns durable workspace roots, addressed by registered id. */
  readonly nativeWorkspaces: boolean;
  /** `workspaces.list()` is authoritative and must be reconciled at startup. */
  readonly workspaceAuthority: boolean;
  readonly workspaceFolderPicker: boolean;
  readonly defaultWorkspace: boolean;
  readonly filesystemV2: boolean;
  /** Can show an entry in the OS file manager. iOS cannot. */
  readonly revealInFileManager: boolean;
  readonly openWorkspaceFolder: boolean;
  readonly externalNavigation: boolean;
  readonly clipboard: boolean;
  /** Any host-owned save path at all. */
  readonly exportDestinations: boolean;
  /** Remembered, re-resolvable export targets (`resolveTarget`/`pickTarget`). */
  readonly exportRememberedTargets: boolean;
  readonly externalResources: boolean;
  readonly openRequests: boolean;
  readonly menuCommands: boolean;
  readonly pinnedDocumentMirror: boolean;
  readonly guardedClose: boolean;
  readonly git: boolean;
  readonly updater: boolean;
  readonly systemFfmpeg: boolean;
  /**
   * Assisted writing and review: a streamed completion plus a status channel.
   *
   * The AI abilities below are separate flags rather than one, because they are
   * independently absent. A paired-device mobile host could plausibly transcribe
   * from its own microphone while offering no image generation and no index.
   */
  readonly aiAssist: boolean;
  /** The host can bind a workspace folder to a provider-side index. */
  readonly aiWorkspaceIndex: boolean;
  readonly aiSearch: boolean;
  readonly aiImages: boolean;
  readonly aiTranscription: boolean;
  readonly aiSpeechSynthesis: boolean;
  /** Documents live in the web origin (IndexedDB) rather than on the host. */
  readonly browserOriginStorage: boolean;
  /** The host draws the window chrome, so the shell must leave room for it. */
  readonly ownsWindowChrome: boolean;
}

const NO_CAPABILITIES: HostCapabilities = Object.freeze({
  nativeWorkspaces: false,
  workspaceAuthority: false,
  workspaceFolderPicker: false,
  defaultWorkspace: false,
  filesystemV2: false,
  revealInFileManager: false,
  openWorkspaceFolder: false,
  externalNavigation: false,
  clipboard: false,
  exportDestinations: false,
  exportRememberedTargets: false,
  externalResources: false,
  openRequests: false,
  menuCommands: false,
  pinnedDocumentMirror: false,
  guardedClose: false,
  git: false,
  updater: false,
  systemFfmpeg: false,
  aiAssist: false,
  aiWorkspaceIndex: false,
  aiSearch: false,
  aiImages: false,
  aiTranscription: false,
  aiSpeechSynthesis: false,
  // A browser with no host keeps its documents in the origin.
  browserOriginStorage: true,
  ownsWindowChrome: false,
});

/** All-false (plus browser storage) — exported so callers can render hostless. */
export const NO_HOST_CAPABILITIES = NO_CAPABILITIES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasMethod(container: unknown, name: string): boolean {
  return isRecord(container) && typeof container[name] === 'function';
}

function hasObject(container: unknown, name: string): boolean {
  return isRecord(container) && isRecord(container[name]);
}

/**
 * Parse the host-declared environment.
 *
 * `env` is data crossing a trust boundary, so it gets a real parser rather than
 * a cast. An unknown surface or platform, an unbounded string, or an unexpected
 * key makes the whole host untrusted — `deriveHostCapabilities` then reports
 * nothing, which fails closed instead of half-enabling a bridge we do not
 * understand.
 */
export function parseHostEnvironment(value: unknown): HostEnvironment | null {
  if (!isRecord(value)) return null;

  const allowed = new Set(['surface', 'surfaceLabel', 'platform', 'appVersion', 'isDev']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return null;
  }

  const { surface, surfaceLabel, platform, appVersion, isDev } = value;
  if (typeof surface !== 'string' || !HOST_SURFACE_KINDS.includes(surface as HostSurfaceKind)) {
    return null;
  }
  if (typeof platform !== 'string' || !HOST_PLATFORMS.includes(platform as HostPlatform)) {
    return null;
  }
  if (!isBoundedString(surfaceLabel, HOST_WIRE_LIMITS.labelCharacters)) return null;
  if (!isBoundedString(appVersion, HOST_WIRE_LIMITS.labelCharacters)) return null;
  if (typeof isDev !== 'boolean') return null;

  return Object.freeze({
    surface: surface as HostSurfaceKind,
    surfaceLabel,
    platform: platform as HostPlatform,
    appVersion,
    isDev,
  });
}

/**
 * Derive capabilities from what the bridge actually exposes.
 *
 * Observed, never self-declared: a host cannot claim a capability whose API
 * member is missing, nor hide one whose member is present, so the two can never
 * drift. It also means preload or plugin version skew degrades to "unsupported"
 * rather than to a runtime TypeError on first use. This mirrors what
 * `ElectronFileSystemProviderV2` already does when it feature-detects the
 * chunked-transfer methods.
 */
export function deriveHostCapabilities(host: unknown): HostCapabilities {
  if (!isRecord(host)) return NO_CAPABILITIES;
  const environment = parseHostEnvironment(host.env);
  if (!environment) return NO_CAPABILITIES;

  const workspaces = host.workspaces;
  const shell = host.shell;
  const exports = host.exports;

  return Object.freeze({
    nativeWorkspaces: hasMethod(workspaces, 'register'),
    workspaceAuthority: hasMethod(workspaces, 'list'),
    workspaceFolderPicker: hasMethod(workspaces, 'pickFolder'),
    defaultWorkspace: hasMethod(workspaces, 'getDefault'),
    filesystemV2: hasObject(host, 'fsV2'),
    revealInFileManager: hasMethod(shell, 'revealInFolder'),
    openWorkspaceFolder: hasMethod(shell, 'openWorkspaceFolder'),
    externalNavigation: hasMethod(shell, 'openExternal'),
    clipboard: hasMethod(host.clipboard, 'writeText'),
    exportDestinations: hasMethod(exports, 'save'),
    exportRememberedTargets:
      hasMethod(exports, 'resolveTarget') && hasMethod(exports, 'pickTarget'),
    externalResources: hasMethod(host.external, 'readText'),
    openRequests: hasMethod(host, 'onOpenRequest'),
    menuCommands: hasMethod(host, 'onMenuCommand'),
    pinnedDocumentMirror: hasMethod(host.menu, 'setPinnedDocuments'),
    guardedClose: hasMethod(host.lifecycle, 'onPrepareClose'),
    git: hasMethod(host.git, 'status'),
    updater: hasMethod(host.updater, 'checkForUpdates'),
    systemFfmpeg: hasMethod(host.ffmpeg, 'available'),
    // Both members are required: a bridge that can start a stream but cannot
    // report status leaves the UI unable to say why nothing is happening.
    aiAssist: hasMethod(host.ai, 'chat') && hasMethod(host.ai, 'onStatus'),
    aiWorkspaceIndex: hasMethod(host.ai, 'ensureWorkspace'),
    aiSearch: hasMethod(host.ai, 'search'),
    aiImages: hasMethod(host.ai, 'generateImage'),
    aiTranscription: hasMethod(host.ai, 'transcribe'),
    aiSpeechSynthesis: hasMethod(host.ai, 'synthesize'),
    // A host that owns workspace roots keeps documents outside the web origin.
    browserOriginStorage: !hasMethod(workspaces, 'register'),
    ownsWindowChrome: environment.surface === 'electron',
  });
}
