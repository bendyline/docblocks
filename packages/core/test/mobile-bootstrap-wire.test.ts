import { expect } from 'chai';

import { parseMobileBootstrap } from '../src/host/mobile-wire.js';

function bootstrap(workspace: Record<string, unknown>) {
  return {
    env: {
      surface: 'capacitor',
      surfaceLabel: 'Android',
      platform: 'android',
      appVersion: '1.0.16',
      isDev: false,
    },
    workspaces: [workspace],
    folderPicker: true,
    // What DocBlocksMobilePlugin.java reports.
    capabilities: {
      writeAtomicity: 'process',
      moveAtomicity: 'process',
      snapshotAtomicity: 'process',
      conditionalWrite: 'process',
      recursiveRemove: true,
      watch: false,
      caseSensitivity: 'platform',
      symlinkPolicy: 'reject',
      durability: 'best-effort',
    },
  };
}

describe('mobile bootstrap wire', () => {
  it('passes on that the on-device workspace is deleted with the app', () => {
    const parsed = parseMobileBootstrap(
      bootstrap({
        id: 'local',
        name: 'On this device',
        rootPath: 'On this device / DocBlocks',
        deletedWithApp: true,
      }),
    );
    expect(parsed.workspaces[0].deletedWithApp).to.equal(true);
  });

  it('leaves the flag out for a folder', () => {
    const parsed = parseMobileBootstrap(
      bootstrap({ id: 'local', name: 'DocBlocks', rootPath: 'Files / DocBlocks' }),
    );
    expect(parsed.workspaces[0]).to.not.have.property('deletedWithApp');
  });

  it('rejects a flag that is not a boolean', () => {
    expect(() =>
      parseMobileBootstrap(
        bootstrap({ id: 'local', name: 'On this device', rootPath: 'x', deletedWithApp: 'yes' }),
      ),
    ).to.throw();
  });
});
