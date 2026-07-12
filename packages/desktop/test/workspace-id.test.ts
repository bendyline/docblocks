import { expect } from 'chai';
import path from 'node:path';

import {
  allocateWorkspaceId,
  deriveWorkspaceId,
  repairWorkspaceIdentities,
} from '../main/workspace-id.js';

describe('workspace authority ids', () => {
  it('does not collide for same-named folders with a shared path prefix', () => {
    const first = path.resolve('C:/Users/example/one/docs');
    const second = path.resolve('C:/Users/example/two/docs');

    expect(deriveWorkspaceId(first)).not.to.equal(deriveWorkspaceId(second));
    expect(deriveWorkspaceId(first)).to.equal(deriveWorkspaceId(first));
    expect(deriveWorkspaceId(first)).to.match(/^electron-docs-[0-9a-f]{16}$/u);
  });

  it('migrates duplicate legacy ids without changing unrelated descriptors', () => {
    const first = path.resolve('C:/Users/example/one/docs');
    const second = path.resolve('C:/Users/example/two/docs');
    const unique = path.resolve('C:/Users/example/three/notes');
    const repaired = repairWorkspaceIdentities([
      { id: 'electron-docs-433a2f557365', name: 'First', rootPath: first },
      { id: 'electron-docs-433a2f557365', name: 'Second', rootPath: second },
      { id: 'legacy-unique', name: 'Unique', rootPath: unique },
    ]);

    expect(repaired.changed).to.equal(true);
    expect(repaired.records.map((record) => record.id)).to.deep.equal([
      deriveWorkspaceId(first),
      deriveWorkspaceId(second),
      'legacy-unique',
    ]);
    expect(new Set(repaired.records.map((record) => record.id)).size).to.equal(3);
  });

  it('collapses duplicate descriptors for the same root to the latest record', () => {
    const rootPath = path.resolve('C:/Users/example/docs');
    const repaired = repairWorkspaceIdentities([
      { id: 'legacy-id', name: 'Old name', rootPath },
      { id: 'legacy-id', name: 'New name', rootPath },
    ]);

    expect(repaired.changed).to.equal(true);
    expect(repaired.records).to.deep.equal([{ id: 'legacy-id', name: 'New name', rootPath }]);
  });

  it('deterministically extends the digest if an id is already owned by another root', () => {
    const first = path.resolve('C:/Users/example/one/docs');
    const second = path.resolve('C:/Users/example/two/docs');
    const collidingId = deriveWorkspaceId(second);

    const allocated = allocateWorkspaceId(second, [{ id: collidingId, rootPath: first }]);
    expect(allocated).to.match(/^electron-docs-[0-9a-f]{24}$/u);
    expect(allocated).not.to.equal(collidingId);
    expect(allocateWorkspaceId(second, [{ id: collidingId, rootPath: second }])).to.equal(
      collidingId,
    );
  });
});
