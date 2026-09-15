import { expect } from 'chai';
import {
  NO_HOST_CAPABILITIES,
  deriveHostCapabilities,
  parseHostEnvironment,
} from '../src/host/capabilities.js';

const VALID_ENV = Object.freeze({
  surface: 'electron',
  surfaceLabel: 'desktop',
  platform: 'darwin',
  appVersion: '2.6.2',
  isDev: false,
});

/** Shaped like the real Electron preload: every member present. */
function electronHost(): Record<string, unknown> {
  return {
    env: { ...VALID_ENV },
    fs: { readFile: () => undefined },
    fsV2: { open: () => undefined },
    external: { readText: () => undefined },
    workspaces: {
      list: () => undefined,
      getDefault: () => undefined,
      pickFolder: () => undefined,
      register: () => undefined,
    },
    shell: {
      openExternal: () => undefined,
      revealInFolder: () => undefined,
      openWorkspaceFolder: () => undefined,
    },
    clipboard: { writeText: () => undefined },
    exports: {
      save: () => undefined,
      resolveTarget: () => undefined,
      pickTarget: () => undefined,
    },
    ffmpeg: { available: () => undefined },
    ai: {
      status: () => undefined,
      onStatus: () => undefined,
      getPreferences: () => undefined,
      setPreferences: () => undefined,
      connect: () => undefined,
      disconnect: () => undefined,
      models: () => undefined,
      chat: () => undefined,
      ensureWorkspace: () => undefined,
      search: () => undefined,
      generateImage: () => undefined,
      transcribe: () => undefined,
      synthesize: () => undefined,
    },
    git: { status: () => undefined },
    updater: { checkForUpdates: () => undefined },
    lifecycle: { onPrepareClose: () => undefined },
    menu: { setPinnedDocuments: () => undefined },
    onMenuCommand: () => undefined,
    onOpenRequest: () => undefined,
  };
}

/**
 * Exactly the shape a Capacitor host is planned to install: no legacy `fs`
 * facade, no Git, no updater, no native menu, no system FFmpeg, a `shell` that
 * can only open a URL, and an `exports` that can only hand bytes to a share
 * sheet. Asserting against it here validates the capability model against its
 * real future consumer before that consumer exists.
 *
 * Its AI namespace is deliberately partial: a paired-device host can send a
 * prompt and can transcribe from the device microphone, but has no workspace
 * index, no search, no image generation and no speech synthesis. That is the
 * case the per-ability flags exist for.
 */
function mobileHost(): Record<string, unknown> {
  return {
    env: { ...VALID_ENV, surface: 'capacitor', surfaceLabel: 'iOS', platform: 'ios' },
    fsV2: { open: () => undefined },
    external: { readText: () => undefined },
    workspaces: {
      list: () => undefined,
      getDefault: () => undefined,
      pickFolder: () => undefined,
      register: () => undefined,
    },
    shell: { openExternal: () => undefined },
    clipboard: { writeText: () => undefined },
    exports: { save: () => undefined },
    ai: {
      status: () => undefined,
      onStatus: () => undefined,
      getPreferences: () => undefined,
      setPreferences: () => undefined,
      connect: () => undefined,
      disconnect: () => undefined,
      models: () => undefined,
      chat: () => undefined,
      transcribe: () => undefined,
    },
    lifecycle: { onPrepareClose: () => undefined },
    onOpenRequest: () => undefined,
  };
}

describe('parseHostEnvironment', () => {
  it('accepts a well-formed environment', () => {
    expect(parseHostEnvironment({ ...VALID_ENV })).to.deep.equal(VALID_ENV);
  });

  it('accepts the mobile platforms', () => {
    for (const platform of ['ios', 'android']) {
      const parsed = parseHostEnvironment({ ...VALID_ENV, surface: 'capacitor', platform });
      expect(parsed?.platform, platform).to.equal(platform);
    }
  });

  it('rejects an unknown surface or platform', () => {
    expect(parseHostEnvironment({ ...VALID_ENV, surface: 'tauri' })).to.equal(null);
    expect(parseHostEnvironment({ ...VALID_ENV, platform: 'freebsd' })).to.equal(null);
  });

  it('rejects unknown keys rather than ignoring them', () => {
    // Types are not boundary validation: an unexpected field means this is not
    // the bridge we think it is.
    expect(parseHostEnvironment({ ...VALID_ENV, extra: true })).to.equal(null);
  });

  it('rejects unbounded or wrongly-typed fields', () => {
    expect(parseHostEnvironment({ ...VALID_ENV, appVersion: 'x'.repeat(5000) })).to.equal(null);
    expect(parseHostEnvironment({ ...VALID_ENV, isDev: 'no' })).to.equal(null);
    expect(parseHostEnvironment({ ...VALID_ENV, surfaceLabel: 42 })).to.equal(null);
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'electron', 42, []]) {
      expect(parseHostEnvironment(value)).to.equal(null);
    }
  });
});

describe('deriveHostCapabilities', () => {
  it('reports nothing when there is no host', () => {
    expect(deriveHostCapabilities(null)).to.equal(NO_HOST_CAPABILITIES);
    expect(deriveHostCapabilities(undefined)).to.equal(NO_HOST_CAPABILITIES);
  });

  it('fails closed when the environment does not parse', () => {
    // A bridge we cannot identify is more dangerous than no bridge: half of it
    // might be a different contract version.
    const host = { ...electronHost(), env: { surface: 'tauri' } };
    expect(deriveHostCapabilities(host)).to.equal(NO_HOST_CAPABILITIES);
  });

  it('reports the full set for an Electron-shaped host', () => {
    const capabilities = deriveHostCapabilities(electronHost());
    for (const [name, value] of Object.entries(capabilities)) {
      const expected = name !== 'browserOriginStorage';
      expect(value, name).to.equal(expected);
    }
  });

  it('reports a mobile-shaped host honestly', () => {
    const capabilities = deriveHostCapabilities(mobileHost());

    // Present and real.
    expect(capabilities.nativeWorkspaces).to.equal(true);
    expect(capabilities.workspaceAuthority).to.equal(true);
    expect(capabilities.workspaceFolderPicker).to.equal(true);
    expect(capabilities.filesystemV2).to.equal(true);
    expect(capabilities.externalNavigation).to.equal(true);
    expect(capabilities.externalResources).to.equal(true);
    expect(capabilities.openRequests).to.equal(true);
    expect(capabilities.guardedClose).to.equal(true);
    expect(capabilities.clipboard).to.equal(true);
    // It can hand bytes to a share sheet, but cannot remember a destination.
    expect(capabilities.exportDestinations).to.equal(true);
    expect(capabilities.exportRememberedTargets).to.equal(false);

    // Genuinely absent.
    expect(capabilities.revealInFileManager).to.equal(false);
    expect(capabilities.openWorkspaceFolder).to.equal(false);
    expect(capabilities.menuCommands).to.equal(false);
    expect(capabilities.pinnedDocumentMirror).to.equal(false);
    expect(capabilities.git).to.equal(false);
    expect(capabilities.updater).to.equal(false);
    expect(capabilities.systemFfmpeg).to.equal(false);
    expect(capabilities.ownsWindowChrome).to.equal(false);

    // Documents live on the device, not in the web origin.
    expect(capabilities.browserOriginStorage).to.equal(false);
  });

  it('never claims a capability whose bridge member is missing', () => {
    // Capabilities are observed, not declared, so preload/plugin version skew
    // degrades to "unsupported" instead of a TypeError on first use.
    const host = electronHost();
    delete host.git;
    delete host.updater;
    const capabilities = deriveHostCapabilities(host);
    expect(capabilities.git).to.equal(false);
    expect(capabilities.updater).to.equal(false);
    expect(capabilities.filesystemV2).to.equal(true);
  });

  it('treats a present-but-wrong member as absent', () => {
    const host = { ...electronHost(), git: 'yes', updater: {} };
    const capabilities = deriveHostCapabilities(host);
    expect(capabilities.git).to.equal(false);
    expect(capabilities.updater).to.equal(false);
  });

  it('reports no AI at all when the namespace is absent', () => {
    // An unsupported platform omits the whole namespace rather than exposing
    // one whose every call fails, so every AI flag must read false.
    const host = electronHost();
    delete host.ai;
    const capabilities = deriveHostCapabilities(host);
    expect(capabilities.aiAssist).to.equal(false);
    expect(capabilities.aiWorkspaceIndex).to.equal(false);
    expect(capabilities.aiSearch).to.equal(false);
    expect(capabilities.aiImages).to.equal(false);
    expect(capabilities.aiTranscription).to.equal(false);
    expect(capabilities.aiSpeechSynthesis).to.equal(false);
    // Everything unrelated still works.
    expect(capabilities.filesystemV2).to.equal(true);
  });

  it('does not claim assisted writing from a stream with no status channel', () => {
    // Both members are required: a UI that cannot observe status cannot explain
    // why a request is doing nothing.
    const host = electronHost();
    host.ai = { chat: () => undefined };
    expect(deriveHostCapabilities(host).aiAssist).to.equal(false);
  });

  it('treats an empty AI namespace as absent', () => {
    const host = { ...electronHost(), ai: {} };
    const capabilities = deriveHostCapabilities(host);
    expect(capabilities.aiAssist).to.equal(false);
    expect(capabilities.aiSearch).to.equal(false);
  });
});
