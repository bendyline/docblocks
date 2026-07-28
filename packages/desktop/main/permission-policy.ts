import { isTrustedRendererUrl } from '@bendyline/docblocks/host';
import type {
  DisplayMediaRequestHandlerHandlerRequest,
  PermissionCheckHandlerHandlerDetails,
  Session,
  Streams,
  WebContents,
} from 'electron';

type PermissionRequestHandler = Exclude<
  Parameters<Session['setPermissionRequestHandler']>[0],
  null
>;
type PermissionRequestName = Parameters<PermissionRequestHandler>[1];
type PermissionRequestDetails = Parameters<PermissionRequestHandler>[3];
type PermissionCheckHandler = Exclude<Parameters<Session['setPermissionCheckHandler']>[0], null>;
type PermissionCheckName = Parameters<PermissionCheckHandler>[1];

const ALLOWED_PERMISSION_REQUESTS = new Set<PermissionRequestName>([
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'media',
]);

const ALLOWED_PERMISSION_CHECKS = new Set<PermissionCheckName>([
  'clipboard-sanitized-write',
  'fullscreen',
  'media',
]);

export interface DisplayCaptureSource {
  id: string;
  name: string;
  display_id: string;
}

export interface DesktopPermissionPolicyOptions {
  session: Pick<
    Session,
    'setDisplayMediaRequestHandler' | 'setPermissionCheckHandler' | 'setPermissionRequestHandler'
  >;
  getOwner: () => WebContents | null;
  getDisplaySources: () => Promise<readonly DisplayCaptureSource[]>;
  getPrimaryDisplayId: () => number;
  platform: NodeJS.Platform;
  developmentOrigin?: string;
}

function hasTrustedUrl(value: unknown, developmentOrigin?: string): boolean {
  return isTrustedRendererUrl(value, developmentOrigin);
}

/**
 * Permissions belong only to the one main renderer frame owned by DocBlocks.
 *
 * The URL checks are intentionally redundant with the WebContents identity:
 * navigation and process swaps can happen between a permission check and its
 * eventual request. Every callback therefore proves the current document,
 * sender, and request metadata still identify the trusted renderer.
 */
function isTrustedMainFrame(
  owner: WebContents | null,
  sender: WebContents | null,
  requestingUrl: unknown,
  securityOrigin: unknown,
  isMainFrame: boolean,
  developmentOrigin?: string,
): boolean {
  if (!owner || !sender || owner !== sender || !isMainFrame || owner.isDestroyed()) return false;

  try {
    const frame = owner.mainFrame;
    return (
      !frame.isDestroyed() &&
      frame.parent === null &&
      hasTrustedUrl(owner.getURL(), developmentOrigin) &&
      hasTrustedUrl(frame.url, developmentOrigin) &&
      hasTrustedUrl(requestingUrl, developmentOrigin) &&
      (securityOrigin === undefined ||
        securityOrigin === '' ||
        hasTrustedUrl(securityOrigin, developmentOrigin))
    );
  } catch {
    // A renderer can disappear or navigate while Chromium is asking.
    return false;
  }
}

function permissionSecurityOrigin(details: PermissionRequestDetails): string | undefined {
  return 'securityOrigin' in details ? details.securityOrigin : undefined;
}

export function allowsPermissionRequest(
  owner: WebContents | null,
  sender: WebContents,
  permission: PermissionRequestName,
  details: PermissionRequestDetails,
  developmentOrigin?: string,
): boolean {
  return (
    ALLOWED_PERMISSION_REQUESTS.has(permission) &&
    isTrustedMainFrame(
      owner,
      sender,
      details.requestingUrl,
      permissionSecurityOrigin(details),
      details.isMainFrame,
      developmentOrigin,
    )
  );
}

export function allowsPermissionCheck(
  owner: WebContents | null,
  sender: WebContents | null,
  permission: PermissionCheckName,
  requestingOrigin: string,
  details: PermissionCheckHandlerHandlerDetails,
  developmentOrigin?: string,
): boolean {
  if (
    !ALLOWED_PERMISSION_CHECKS.has(permission) ||
    details.embeddingOrigin !== undefined ||
    !isTrustedMainFrame(
      owner,
      sender,
      details.requestingUrl ?? requestingOrigin,
      details.securityOrigin ?? requestingOrigin,
      details.isMainFrame,
      developmentOrigin,
    )
  ) {
    return false;
  }

  return hasTrustedUrl(requestingOrigin, developmentOrigin);
}

export function allowsDisplayMediaRequest(
  owner: WebContents | null,
  request: DisplayMediaRequestHandlerHandlerRequest,
  developmentOrigin?: string,
): boolean {
  const frame = request.frame;
  if (
    !owner ||
    !frame ||
    owner.isDestroyed() ||
    frame.isDestroyed() ||
    frame !== owner.mainFrame ||
    frame.parent !== null ||
    !request.userGesture ||
    !request.videoRequested
  ) {
    return false;
  }

  return (
    hasTrustedUrl(owner.getURL(), developmentOrigin) &&
    hasTrustedUrl(frame.url, developmentOrigin) &&
    hasTrustedUrl(frame.origin, developmentOrigin) &&
    hasTrustedUrl(request.securityOrigin, developmentOrigin)
  );
}

export function selectDisplayCaptureSource(
  sources: readonly DisplayCaptureSource[],
  primaryDisplayId: number,
): DisplayCaptureSource | null {
  if (sources.length === 0) return null;
  const primaryId = String(primaryDisplayId);
  return sources.find((source) => source.display_id === primaryId) ?? sources[0] ?? null;
}

export function displayMediaHandlerOptions(platform: NodeJS.Platform): {
  useSystemPicker: boolean;
} {
  // Electron 43 exposes the system picker only on macOS 15+; on older macOS
  // versions the registered handler remains the fail-closed fallback.
  return { useSystemPicker: platform === 'darwin' };
}

export function grantedDisplayStreams(
  source: DisplayCaptureSource,
  audioRequested: boolean,
  platform: NodeJS.Platform,
): Streams {
  return {
    video: { id: source.id, name: source.name },
    // Electron documents loopback capture for Windows. Other platforms keep
    // the request video-only unless their native system picker supplies audio.
    ...(audioRequested && platform === 'win32' ? { audio: 'loopback' as const } : {}),
  };
}

export function configureDesktopPermissionPolicy(options: DesktopPermissionPolicyOptions): void {
  const { session, getOwner, getDisplaySources, getPrimaryDisplayId, platform, developmentOrigin } =
    options;

  session.setPermissionRequestHandler((sender, permission, callback, details) => {
    callback(allowsPermissionRequest(getOwner(), sender, permission, details, developmentOrigin));
  });

  session.setPermissionCheckHandler((sender, permission, requestingOrigin, details) =>
    allowsPermissionCheck(
      getOwner(),
      sender,
      permission,
      requestingOrigin,
      details,
      developmentOrigin,
    ),
  );

  session.setDisplayMediaRequestHandler((request, callback) => {
    if (!allowsDisplayMediaRequest(getOwner(), request, developmentOrigin)) {
      callback({});
      return;
    }

    void getDisplaySources()
      .then((sources) => {
        // Source enumeration can show an OS picker and outlive the original
        // document. Revalidate ownership before granting the selected stream.
        if (!allowsDisplayMediaRequest(getOwner(), request, developmentOrigin)) {
          callback({});
          return;
        }
        const source = selectDisplayCaptureSource(sources, getPrimaryDisplayId());
        callback(source ? grantedDisplayStreams(source, request.audioRequested, platform) : {});
      })
      .catch(() => callback({}));
  }, displayMediaHandlerOptions(platform));
}
