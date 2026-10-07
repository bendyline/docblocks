import { expect } from 'chai';
import {
  getHostCapabilities,
  getHostEnvironment,
  hasDocBlocksHost,
  hostSupports,
} from '@bendyline/docblocks/host';

/**
 * The accessor layer the shell actually calls, exercised through the real
 * `globalThis.docBlocksHost` global rather than by calling
 * `deriveHostCapabilities` directly (which `packages/core/test/host-capabilities.test.ts`
 * covers). This is the path every capability branch in `DocBlocksShell` takes.
 */

function installHost(host: unknown): void {
  (globalThis as { docBlocksHost?: unknown }).docBlocksHost = host;
}

function clearHost(): void {
  delete (globalThis as { docBlocksHost?: unknown }).docBlocksHost;
}

const ELECTRON_HOST = {
  env: {
    surface: 'electron',
    surfaceLabel: 'desktop',
    platform: 'darwin',
    appVersion: '2.6.2',
    isDev: false,
  },
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
  exports: { save: () => undefined, resolveTarget: () => undefined, pickTarget: () => undefined },
  ffmpeg: { available: () => undefined },
  git: { status: () => undefined },
  updater: { checkForUpdates: () => undefined },
  lifecycle: { onPrepareClose: () => undefined },
  menu: { setPinnedDocuments: () => undefined },
  onMenuCommand: () => undefined,
  onOpenRequest: () => undefined,
};

/**
 * The shape the planned Capacitor bridge will install. Keep in sync with
 * `docs`/the mobile plan: this fixture is how the shell's capability branches
 * are validated against their real future consumer before it exists.
 */
const MOBILE_HOST = {
  env: {
    surface: 'capacitor',
    surfaceLabel: 'iOS',
    platform: 'ios',
    appVersion: '1.0.0',
    isDev: false,
  },
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
  lifecycle: { onPrepareClose: () => undefined },
  onOpenRequest: () => undefined,
};

describe('shell host capability accessors', () => {
  afterEach(clearHost);

  describe('with no host (the site in a browser tab)', () => {
    it('reports no host and no capabilities', () => {
      clearHost();
      expect(hasDocBlocksHost()).to.equal(false);
      expect(getHostEnvironment()).to.equal(null);
      expect(hostSupports('nativeWorkspaces')).to.equal(false);
      expect(hostSupports('git')).to.equal(false);
      expect(hostSupports('exportDestinations')).to.equal(false);
    });

    it('still says documents live in the web origin', () => {
      clearHost();
      // Drives the browser-storage eviction warning, which a hostless surface
      // very much needs to show.
      expect(hostSupports('browserOriginStorage')).to.equal(true);
    });
  });

  describe('with the Electron host', () => {
    it('reports the desktop capability set and identity', () => {
      installHost(ELECTRON_HOST);
      expect(hasDocBlocksHost()).to.equal(true);
      expect(getHostEnvironment()?.surface).to.equal('electron');
      expect(getHostEnvironment()?.surfaceLabel).to.equal('desktop');

      for (const capability of [
        'nativeWorkspaces',
        'workspaceAuthority',
        'revealInFileManager',
        'openWorkspaceFolder',
        'menuCommands',
        'pinnedDocumentMirror',
        'git',
        'updater',
        'systemFfmpeg',
        'exportRememberedTargets',
        'ownsWindowChrome',
      ] as const) {
        expect(hostSupports(capability), capability).to.equal(true);
      }
      expect(hostSupports('browserOriginStorage')).to.equal(false);
    });
  });

  describe('with a mobile-shaped host', () => {
    it('keeps the capabilities it genuinely has', () => {
      installHost(MOBILE_HOST);
      expect(hasDocBlocksHost()).to.equal(true);
      expect(getHostEnvironment()?.surfaceLabel).to.equal('iOS');
      for (const capability of [
        'nativeWorkspaces',
        'workspaceAuthority',
        'workspaceFolderPicker',
        'filesystemV2',
        'externalNavigation',
        'externalResources',
        'openRequests',
        'guardedClose',
        'exportDestinations',
      ] as const) {
        expect(hostSupports(capability), capability).to.equal(true);
      }
    });

    it('drops the ones it does not, instead of inheriting them from Electron', () => {
      installHost(MOBILE_HOST);
      for (const capability of [
        // iOS has no "reveal in file manager" and no folder-opening concept.
        'revealInFileManager',
        'openWorkspaceFolder',
        // No native menu bar, no tray to mirror pinned documents into.
        'menuCommands',
        'pinnedDocumentMirror',
        'git',
        // The store delivers updates.
        'updater',
        'systemFfmpeg',
        // It can hand bytes to a share sheet but cannot remember a destination.
        'exportRememberedTargets',
        'ownsWindowChrome',
      ] as const) {
        expect(hostSupports(capability), capability).to.equal(false);
      }
    });

    it('keeps documents out of the web origin', () => {
      installHost(MOBILE_HOST);
      // Documents live in the app container, so the eviction warning that the
      // site shows would be wrong here.
      expect(hostSupports('browserOriginStorage')).to.equal(false);
    });
  });

  it('treats an unidentifiable bridge as no host at all', () => {
    // The pre-capability duck-type: an `fs` object and nothing else. Trusting
    // half of an unknown contract is worse than ignoring it.
    installHost({ fs: {} });
    expect(hasDocBlocksHost()).to.equal(false);
    expect(getHostCapabilities().filesystemV2).to.equal(false);
  });
});
