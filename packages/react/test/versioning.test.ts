/**
 * Tests for the versioning preference resolver.
 *
 * Two surfaces under test:
 *   1. load/save against localStorage (with malformed-data resilience)
 *   2. resolveVersioningEnabled — three-way fold over global preference
 *      and per-workspace override, gated by workspace type.
 *
 * The defaults matter: `browser-only` means IndexedDB workspaces version,
 * native/electron-native folders don't. Regressing that pollutes user
 * folders with `.versions/` directories — exactly the kind of silent
 * change we want a test to catch.
 */
import { expect } from 'chai';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import {
  isLocalWorkspaceType,
  loadVersioningPreference,
  resolveVersioningEnabled,
  saveVersioningPreference,
  type VersioningPreference,
} from '../src/preferences/versioning.js';

const STORAGE_KEY = 'docblocks:versioningPreference';

function workspace(
  type: WorkspaceDescriptor['type'],
  override?: VersioningPreference | 'inherit',
): WorkspaceDescriptor {
  return {
    id: `ws-${type}`,
    name: `Workspace ${type}`,
    type,
    lastOpened: new Date().toISOString(),
    versioningOverride: override,
  };
}

describe('versioning preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('isLocalWorkspaceType', () => {
    it('treats native + electron-native folders as local', () => {
      expect(isLocalWorkspaceType('native')).to.equal(true);
      expect(isLocalWorkspaceType('electron-native')).to.equal(true);
    });

    it('treats IndexedDB workspaces as non-local', () => {
      expect(isLocalWorkspaceType('indexeddb')).to.equal(false);
    });
  });

  describe('load/save', () => {
    it('round-trips a valid preference', () => {
      saveVersioningPreference('off');
      expect(loadVersioningPreference()).to.equal('off');
      saveVersioningPreference('on');
      expect(loadVersioningPreference()).to.equal('on');
    });

    it('falls back to browser-only when nothing is stored', () => {
      expect(loadVersioningPreference()).to.equal('browser-only');
    });

    it('falls back to browser-only on malformed value', () => {
      localStorage.setItem(STORAGE_KEY, 'wat');
      expect(loadVersioningPreference()).to.equal('browser-only');
    });
  });

  describe('resolveVersioningEnabled', () => {
    it('returns false when there is no workspace, regardless of pref', () => {
      expect(resolveVersioningEnabled(null, 'on')).to.equal(false);
      expect(resolveVersioningEnabled(null, 'off')).to.equal(false);
      expect(resolveVersioningEnabled(null, 'browser-only')).to.equal(false);
    });

    it('per-workspace override beats global preference', () => {
      expect(resolveVersioningEnabled(workspace('native', 'on'), 'off')).to.equal(true);
      expect(resolveVersioningEnabled(workspace('indexeddb', 'off'), 'on')).to.equal(false);
    });

    it('"inherit" override defers to global preference', () => {
      // Inherit + global=on → on for any workspace type
      expect(resolveVersioningEnabled(workspace('native', 'inherit'), 'on')).to.equal(true);
      expect(resolveVersioningEnabled(workspace('indexeddb', 'inherit'), 'on')).to.equal(true);
      // Inherit + global=off → off for any workspace type
      expect(resolveVersioningEnabled(workspace('native', 'inherit'), 'off')).to.equal(false);
    });

    it('absent override defers to global preference (same as "inherit")', () => {
      expect(resolveVersioningEnabled(workspace('native'), 'on')).to.equal(true);
      expect(resolveVersioningEnabled(workspace('indexeddb'), 'on')).to.equal(true);
      expect(resolveVersioningEnabled(workspace('native'), 'off')).to.equal(false);
    });

    it('browser-only enables versioning for IndexedDB workspaces', () => {
      expect(resolveVersioningEnabled(workspace('indexeddb'), 'browser-only')).to.equal(true);
    });

    it('browser-only disables versioning for native/electron-native folders', () => {
      expect(resolveVersioningEnabled(workspace('native'), 'browser-only')).to.equal(false);
      expect(resolveVersioningEnabled(workspace('electron-native'), 'browser-only')).to.equal(
        false,
      );
    });
  });
});
