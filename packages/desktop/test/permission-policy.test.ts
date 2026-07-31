import { expect } from 'chai';
import type {
  DisplayMediaRequestHandlerHandlerRequest,
  PermissionCheckHandlerHandlerDetails,
  PermissionRequest,
  WebContents,
  WebFrameMain,
} from 'electron';

import {
  allowsDisplayMediaRequest,
  allowsPermissionCheck,
  allowsPermissionRequest,
  displayMediaHandlerOptions,
  grantedDisplayStreams,
  selectDisplayCaptureSource,
} from '../main/permission-policy.js';

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
