import { expect } from 'chai';

import { reconcileElectronWorkspaceDescriptors } from '../src/workspace/reconcile-electron.js';
import type { WorkspaceDescriptor } from '../src/workspace/types.js';

function electronWorkspace(
  id: string,
  rootPath: string,
  lastOpened = '2025-01-01T00:00:00.000Z',
): WorkspaceDescriptor {
  return { id, name: `Local ${id}`, type: 'electron-native', rootPath, lastOpened };
}

describe('Electron workspace descriptor reconciliation', () => {
  it('recovers renderer metadata after colliding legacy ids are migrated by main', () => {
    const legacyId = 'electron-docs-433a2f557365';
    const local = [electronWorkspace(legacyId, 'C:\\Users\\example\\two\\docs')];
    const result = reconcileElectronWorkspaceDescriptors(
      local,
      [
        {
          id: 'electron-docs-1111111111111111',
          name: 'First',
          rootPath: 'C:\\Users\\example\\one\\docs',
        },
        {
          id: 'electron-docs-2222222222222222',
          name: 'Second',
          rootPath: 'C:\\Users\\example\\two\\docs',
        },
      ],
      'win32',
      '2026-01-01T00:00:00.000Z',
    );

    expect(result.removeIds).to.deep.equal([legacyId]);
    expect(result.upsert.map((workspace) => workspace.id)).to.deep.equal([
      'electron-docs-1111111111111111',
      'electron-docs-2222222222222222',
    ]);
    expect(result.upsert[1].name).to.equal(`Local ${legacyId}`);
    expect(result.upsert[1].lastOpened).to.equal('2025-01-01T00:00:00.000Z');
    expect(result.idRemap).to.deep.equal({
      [legacyId]: 'electron-docs-2222222222222222',
    });
  });

  it('removes local Electron descriptors that are absent from main authority', () => {
    const result = reconcileElectronWorkspaceDescriptors(
      [
        electronWorkspace('trusted', '/work/trusted'),
        electronWorkspace('stale', '/work/no-longer-trusted'),
        {
          id: 'web',
          name: 'Web',
          type: 'indexeddb',
          lastOpened: '2025-01-01T00:00:00.000Z',
        },
      ],
      [{ id: 'trusted', name: 'Trusted', rootPath: '/work/trusted' }],
      'linux',
      '2026-01-01T00:00:00.000Z',
    );

    expect(result.removeIds).to.deep.equal(['stale']);
    expect(result.upsert).to.have.length(1);
    expect(result.upsert[0].id).to.equal('trusted');
    expect(result.idRemap).to.deep.equal({});
  });

  it('matches Windows display paths case-insensitively across slash conventions', () => {
    const result = reconcileElectronWorkspaceDescriptors(
      [electronWorkspace('legacy', 'C:\\Users\\Example\\Docs\\')],
      [{ id: 'canonical', name: 'Docs', rootPath: 'c:/users/example/docs' }],
      'win32',
      '2026-01-01T00:00:00.000Z',
    );

    expect(result.removeIds).to.deep.equal(['legacy']);
    expect(result.upsert[0].name).to.equal('Local legacy');
  });
});
