import { isTrustedRendererUrl } from '@bendyline/docblocks/host';
import type {
  DisplayMediaRequestHandlerHandlerRequest,
  PermissionCheckHandlerHandlerDetails,
  Session,
  Streams,
  SystemPreferences,
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

/**
 * The macOS TCC media types DocBlocks can ask for. `screen` is deliberately
 * absent: macOS has no programmatic prompt for Screen Recording, so a display
 * capture either works or sends the user to System Settings on its own.
 */
export type MacMediaType = 'camera' | 'microphone';

/** The slice of `systemPreferences` the media gate needs (injectable in tests). */
export type MacMediaAccess = Pick<SystemPreferences, 'askForMediaAccess' | 'getMediaAccessStatus'>;

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
  /**
   * macOS only. Omit on other platforms — `requiredMacMediaTypes` returns
   * nothing there, so the gate never runs.
   */
  mediaAccess?: MacMediaAccess;
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

/**
 * macOS gates camera and microphone behind TCC, and Chromium inside Electron
 * never raises that prompt on its own. Without a grant, `getUserMedia`
 * resolves with a track that reports `live`, `enabled`, and unmuted — and
 * then delivers no frames at all (`readyState` stays 0, `videoWidth` 0, and
 * the camera's own indicator light never comes on). There is no error for the
 * renderer to surface, so the preview is simply black forever.
 *
 * `systemPreferences.askForMediaAccess` is the only way to raise the prompt,
 * so a `media` permission request has to name the TCC types it implies before
 * it can be granted.
 *
 * Returns nothing off darwin and nothing for permissions that carry no TCC
 * media type, which keeps the gate a no-op everywhere else. A `media` request
 * with no `mediaTypes` is treated as asking for both — Chromium omits the
 * field on some paths, and a missing prompt is exactly the bug being fixed.
 */
export function requiredMacMediaTypes(
  platform: NodeJS.Platform,
  permission: PermissionRequestName,
  details: PermissionRequestDetails,
): readonly MacMediaType[] {
  if (platform !== 'darwin' || permission !== 'media') return [];
  const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
  if (!mediaTypes) return ['camera', 'microphone'];
  const types: MacMediaType[] = [];
  if (mediaTypes.includes('video')) types.push('camera');
  if (mediaTypes.includes('audio')) types.push('microphone');
  return types;
}

/**
 * Resolve every TCC type the request needs, prompting only for the ones still
 * undecided. `askForMediaAccess` resolves `false` without a prompt once the
 * user has denied or the type is MDM-restricted, which turns the renderer's
 * capture into an honest `NotAllowedError` instead of a black preview the user
 * cannot explain.
 */
export async function grantsMacMediaAccess(
  types: readonly MacMediaType[],
  access: MacMediaAccess | undefined,
): Promise<boolean> {
  if (types.length === 0) return true;
  // No injected accessor on a platform that needs one: fail closed rather than
  // hand Chromium a grant macOS will quietly turn into empty frames.
  if (!access) return false;

  for (const type of types) {
    if (access.getMediaAccessStatus(type) === 'granted') continue;
    if (!(await access.askForMediaAccess(type))) return false;
  }
  return true;
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
  const {
    session,
    getOwner,
    getDisplaySources,
    getPrimaryDisplayId,
    platform,
    developmentOrigin,
    mediaAccess,
  } = options;

  session.setPermissionRequestHandler((sender, permission, callback, details) => {
    const allowed = () =>
      allowsPermissionRequest(getOwner(), sender, permission, details, developmentOrigin);
    if (!allowed()) {
      callback(false);
      return;
    }

    const macMediaTypes = requiredMacMediaTypes(platform, permission, details);
    if (macMediaTypes.length === 0) {
      callback(true);
      return;
    }

    void grantsMacMediaAccess(macMediaTypes, mediaAccess)
      .then((granted) => {
        // The TCC prompt is modal and can outlive the document that triggered
        // it, so re-prove ownership the same way the display-capture handler
        // does after its own async hop.
        callback(granted && allowed());
      })
      .catch(() => callback(false));
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
