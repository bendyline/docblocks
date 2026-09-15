import { expect } from 'chai';
import type {
  DisplayMediaRequestHandlerHandlerRequest,
  MediaAccessPermissionRequest,
  PermissionCheckHandlerHandlerDetails,
  PermissionRequest,
  Session,
  WebContents,
  WebFrameMain,
} from 'electron';

import {
  allowsDisplayMediaRequest,
  allowsPermissionCheck,
  allowsPermissionRequest,
  configureDesktopPermissionPolicy,
  displayMediaHandlerOptions,
  grantedDisplayStreams,
  grantsMacMediaAccess,
  requiredMacMediaTypes,
  selectDisplayCaptureSource,
} from '../main/permission-policy.js';
import type { MacMediaAccess, MacMediaType } from '../main/permission-policy.js';

const TRUSTED_URL = 'app://docblocks/index.html';
const TRUSTED_ORIGIN = 'app://docblocks';

interface FakeRenderer {
  contents: WebContents;
  frame: WebFrameMain;
  destroy(): void;
  navigate(url: string, origin?: string): void;
}

function fakeRenderer(initialUrl = TRUSTED_URL, initialOrigin = TRUSTED_ORIGIN): FakeRenderer {
  let destroyed = false;
  let url = initialUrl;
  let origin = initialOrigin;
  const frame = {
    isDestroyed: () => destroyed,
    parent: null,
    get url() {
      return url;
    },
    get origin() {
      return origin;
    },
  } as unknown as WebFrameMain;
  const contents = {
    isDestroyed: () => destroyed,
    getURL: () => url,
    mainFrame: frame,
  } as unknown as WebContents;

  return {
    contents,
    frame,
    destroy() {
      destroyed = true;
    },
    navigate(nextUrl, nextOrigin = new URL(nextUrl).origin) {
      url = nextUrl;
      origin = nextOrigin;
    },
  };
}

function permissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    isMainFrame: true,
    requestingUrl: TRUSTED_URL,
    ...overrides,
  };
}

type PermissionRequestHandler = Exclude<
  Parameters<Session['setPermissionRequestHandler']>[0],
  null
>;
type PolicySession = Parameters<typeof configureDesktopPermissionPolicy>[0]['session'];

function mediaRequest(
  overrides: Partial<MediaAccessPermissionRequest> = {},
): MediaAccessPermissionRequest {
  return {
    isMainFrame: true,
    requestingUrl: TRUSTED_URL,
    ...overrides,
  };
}

function permissionCheck(
  overrides: Partial<PermissionCheckHandlerHandlerDetails> = {},
): PermissionCheckHandlerHandlerDetails {
  return {
    isMainFrame: true,
    requestingUrl: TRUSTED_URL,
    securityOrigin: TRUSTED_ORIGIN,
    ...overrides,
  };
}

function displayRequest(
  frame: WebFrameMain,
  overrides: Partial<DisplayMediaRequestHandlerHandlerRequest> = {},
): DisplayMediaRequestHandlerHandlerRequest {
  return {
    frame,
    securityOrigin: TRUSTED_ORIGIN,
    videoRequested: true,
    audioRequested: false,
    userGesture: true,
    ...overrides,
  };
}

describe('desktop permission policy', () => {
  it('allows only the intended permissions from the trusted owner main frame', () => {
    const owner = fakeRenderer();
    const details = permissionRequest();

    for (const permission of [
      'clipboard-sanitized-write',
      'display-capture',
      'fullscreen',
      'media',
    ] as const) {
      expect(allowsPermissionRequest(owner.contents, owner.contents, permission, details)).to.equal(
        true,
      );
    }
    expect(
      allowsPermissionRequest(owner.contents, owner.contents, 'geolocation', details),
    ).to.equal(false);
  });

  it('denies an unowned sender, a subframe, an untrusted origin, and a destroyed owner', () => {
    const owner = fakeRenderer();
    const other = fakeRenderer();

    expect(
      allowsPermissionRequest(owner.contents, other.contents, 'media', permissionRequest()),
    ).to.equal(false);
    expect(
      allowsPermissionRequest(
        owner.contents,
        owner.contents,
        'media',
        permissionRequest({ isMainFrame: false }),
      ),
    ).to.equal(false);
    expect(
      allowsPermissionRequest(
        owner.contents,
        owner.contents,
        'media',
        permissionRequest({ requestingUrl: 'https://example.com/' }),
      ),
    ).to.equal(false);

    owner.destroy();
    expect(
      allowsPermissionRequest(owner.contents, owner.contents, 'media', permissionRequest()),
    ).to.equal(false);
  });

  it('applies the same owner, frame, and origin constraints to permission checks', () => {
    const owner = fakeRenderer();
    expect(
      allowsPermissionCheck(
        owner.contents,
        owner.contents,
        'media',
        TRUSTED_ORIGIN,
        permissionCheck(),
      ),
    ).to.equal(true);
    expect(
      allowsPermissionCheck(
        owner.contents,
        owner.contents,
        'fullscreen',
        TRUSTED_ORIGIN,
        permissionCheck(),
      ),
    ).to.equal(true);
    expect(
      allowsPermissionCheck(
        owner.contents,
        owner.contents,
        'geolocation',
        TRUSTED_ORIGIN,
        permissionCheck(),
      ),
    ).to.equal(false);
    expect(
      allowsPermissionCheck(
        owner.contents,
        owner.contents,
        'media',
        TRUSTED_ORIGIN,
        permissionCheck({ embeddingOrigin: 'app://docblocks', isMainFrame: false }),
      ),
    ).to.equal(false);
    expect(
      allowsPermissionCheck(
        owner.contents,
        owner.contents,
        'media',
        'https://example.com',
        permissionCheck(),
      ),
    ).to.equal(false);
  });

  it('requires trusted, current, user-initiated main-frame display capture', () => {
    const owner = fakeRenderer();
    expect(allowsDisplayMediaRequest(owner.contents, displayRequest(owner.frame))).to.equal(true);
    expect(
      allowsDisplayMediaRequest(
        owner.contents,
        displayRequest(owner.frame, { userGesture: false }),
      ),
    ).to.equal(false);
    expect(
      allowsDisplayMediaRequest(
        owner.contents,
        displayRequest(owner.frame, { videoRequested: false, audioRequested: true }),
      ),
    ).to.equal(false);

    const other = fakeRenderer();
    expect(allowsDisplayMediaRequest(owner.contents, displayRequest(other.frame))).to.equal(false);
    owner.navigate('https://example.com/');
    expect(
      allowsDisplayMediaRequest(
        owner.contents,
        displayRequest(owner.frame, {
          securityOrigin: 'https://example.com',
        }),
      ),
    ).to.equal(false);
  });

  it('maps a macOS media request to the TCC types it needs, and nothing elsewhere', () => {
    const media = (mediaTypes?: Array<'video' | 'audio'>) =>
      mediaRequest(mediaTypes ? { mediaTypes } : {});

    expect(requiredMacMediaTypes('darwin', 'media', media(['video']))).to.deep.equal(['camera']);
    expect(requiredMacMediaTypes('darwin', 'media', media(['audio']))).to.deep.equal([
      'microphone',
    ]);
    expect(requiredMacMediaTypes('darwin', 'media', media(['video', 'audio']))).to.deep.equal([
      'camera',
      'microphone',
    ]);
    // Chromium omits mediaTypes on some paths; assume the widest ask.
    expect(requiredMacMediaTypes('darwin', 'media', media())).to.deep.equal([
      'camera',
      'microphone',
    ]);
    expect(requiredMacMediaTypes('darwin', 'display-capture', media(['video']))).to.deep.equal([]);
    expect(requiredMacMediaTypes('win32', 'media', media(['video']))).to.deep.equal([]);
    expect(requiredMacMediaTypes('linux', 'media', media(['video']))).to.deep.equal([]);
  });

  it('prompts only for undecided macOS media types and fails closed otherwise', async () => {
    const asked: MacMediaType[] = [];
    const access = (
      statuses: Partial<Record<MacMediaType, ReturnType<MacMediaAccess['getMediaAccessStatus']>>>,
      answer: boolean,
    ): MacMediaAccess =>
      ({
        getMediaAccessStatus: (type: MacMediaType) => statuses[type] ?? 'not-determined',
        askForMediaAccess: async (type: MacMediaType) => {
          asked.push(type);
          return answer;
        },
      }) as unknown as MacMediaAccess;

    // Already granted: no prompt, still allowed.
    expect(
      await grantsMacMediaAccess(['microphone'], access({ microphone: 'granted' }, false)),
    ).to.equal(true);
    expect(asked).to.deep.equal([]);

    // Undecided: prompt, and honor the answer.
    expect(await grantsMacMediaAccess(['camera'], access({}, true))).to.equal(true);
    expect(asked).to.deep.equal(['camera']);

    asked.length = 0;
    expect(
      await grantsMacMediaAccess(
        ['camera', 'microphone'],
        access({ microphone: 'granted' }, false),
      ),
    ).to.equal(false);
    expect(asked).to.deep.equal(['camera']);

    // Denied/restricted resolve false without a prompt, which is what turns a
    // frameless black preview into a NotAllowedError the renderer can report.
    asked.length = 0;
    expect(await grantsMacMediaAccess(['camera'], access({ camera: 'denied' }, false))).to.equal(
      false,
    );

    expect(await grantsMacMediaAccess([], undefined)).to.equal(true);
    expect(await grantsMacMediaAccess(['camera'], undefined)).to.equal(false);
  });

  it('gates the registered macOS media handler on a TCC grant and revalidates after it', async () => {
    const owner = fakeRenderer();
    // Undecided is the state that makes Chromium hand back a live track with
    // no frames, so it is the one the handler has to turn into a real prompt.
    const status: ReturnType<MacMediaAccess['getMediaAccessStatus']> = 'not-determined';
    let answer = true;
    let beforeAnswer: (() => void) | null = null;
    const asked: MacMediaType[] = [];

    let handler: PermissionRequestHandler | null = null;
    const policy = (platform: NodeJS.Platform): PermissionRequestHandler => {
      configureDesktopPermissionPolicy({
        session: {
          setPermissionRequestHandler: (fn: PermissionRequestHandler | null) => {
            handler = fn;
          },
          setPermissionCheckHandler: () => {},
          setDisplayMediaRequestHandler: () => {},
        } as unknown as PolicySession,
        getOwner: () => owner.contents,
        getDisplaySources: async () => [],
        getPrimaryDisplayId: () => 1,
        platform,
        mediaAccess: {
          getMediaAccessStatus: () => status,
          askForMediaAccess: async (type: MacMediaType) => {
            asked.push(type);
            beforeAnswer?.();
            return answer;
          },
        } as unknown as MacMediaAccess,
      });
      if (!handler) throw new Error('policy did not register a permission request handler');
      return handler;
    };

    const ask = (fn: PermissionRequestHandler, mediaTypes: Array<'video' | 'audio'> = ['video']) =>
      new Promise<boolean>((resolve) => {
        fn(owner.contents, 'media', resolve, mediaRequest({ mediaTypes }));
      });

    const darwin = policy('darwin');
    expect(await ask(darwin)).to.equal(true);
    expect(asked).to.deep.equal(['camera']);

    answer = false;
    expect(await ask(darwin)).to.equal(false);

    // A grant that lands after the owner is gone must not be honored.
    answer = true;
    beforeAnswer = () => owner.destroy();
    expect(await ask(darwin)).to.equal(false);
    beforeAnswer = null;

    // Elsewhere the handler stays synchronous and untouched by TCC.
    const fresh = fakeRenderer();
    asked.length = 0;
    const win = policy('win32');
    await new Promise<void>((resolve) => {
      win(
        fresh.contents,
        'media',
        (granted) => {
          expect(granted).to.equal(false); // getOwner() still points at the destroyed renderer
          resolve();
        },
        mediaRequest({ mediaTypes: ['video'] }),
      );
    });
    expect(asked).to.deep.equal([]);
  });

  it('selects the primary display deterministically and configures the native picker by OS', () => {
    const sources = [
      { id: 'screen:1:0', name: 'Screen 1', display_id: '111' },
      { id: 'screen:2:0', name: 'Screen 2', display_id: '222' },
    ];

    expect(selectDisplayCaptureSource(sources, 222)).to.equal(sources[1]);
    expect(selectDisplayCaptureSource(sources, 999)).to.equal(sources[0]);
    expect(selectDisplayCaptureSource([], 222)).to.equal(null);
    expect(displayMediaHandlerOptions('darwin')).to.deep.equal({ useSystemPicker: true });
    expect(displayMediaHandlerOptions('win32')).to.deep.equal({ useSystemPicker: false });
    expect(displayMediaHandlerOptions('linux')).to.deep.equal({ useSystemPicker: false });
  });

  it('grants requested system loopback audio only where Electron supports it', () => {
    const source = { id: 'screen:1:0', name: 'Screen 1', display_id: '111' };

    expect(grantedDisplayStreams(source, true, 'win32')).to.deep.equal({
      video: { id: source.id, name: source.name },
      audio: 'loopback',
    });
    expect(grantedDisplayStreams(source, true, 'darwin')).to.deep.equal({
      video: { id: source.id, name: source.name },
    });
    expect(grantedDisplayStreams(source, true, 'linux')).to.deep.equal({
      video: { id: source.id, name: source.name },
    });
    expect(grantedDisplayStreams(source, false, 'win32')).to.deep.equal({
      video: { id: source.id, name: source.name },
    });
  });
});
