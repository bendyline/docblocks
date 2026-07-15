import { expect } from 'chai';
import { parsePersistedWorkspaceList } from '../src/workspace/workspace-schema.js';

describe('persisted workspace schema', () => {
  it('accepts exact durable descriptors', () => {
    const lastOpened = new Date('2026-07-15T00:00:00.000Z').toISOString();
    expect(
      parsePersistedWorkspaceList([
        { id: 'local', name: 'Local', type: 'indexeddb', lastOpened },
        {
          id: 'desktop',
          name: 'Desktop',
          type: 'electron-native',
          rootPath: 'C:\\Documents',
          lastOpened,
          versioningOverride: 'on',
        },
      ]),
    ).to.have.length(2);
  });

  for (const [label, value] of [
    [
      'a transient descriptor',
      [{ id: 'x', name: 'X', type: 'transient', lastOpened: new Date().toISOString() }],
    ],
    [
      'an unknown field',
      [
        {
          id: 'x',
          name: 'X',
          type: 'indexeddb',
          lastOpened: new Date().toISOString(),
          extra: true,
        },
      ],
    ],
    [
      'duplicate IDs',
      [
        { id: 'x', name: 'First', type: 'indexeddb', lastOpened: new Date().toISOString() },
        { id: 'x', name: 'Second', type: 'native', lastOpened: new Date().toISOString() },
      ],
    ],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => parsePersistedWorkspaceList(value)).to.throw();
    });
  }
});
