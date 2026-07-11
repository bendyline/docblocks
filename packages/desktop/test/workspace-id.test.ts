import { expect } from 'chai';
import path from 'node:path';

import { deriveWorkspaceId } from '../main/workspace-id.js';

describe('workspace authority ids', () => {
  it('does not collide for same-named folders with a shared path prefix', () => {
    const first = path.resolve('C:/Users/example/one/docs');
    const second = path.resolve('C:/Users/example/two/docs');

    expect(deriveWorkspaceId(first)).not.to.equal(deriveWorkspaceId(second));
    expect(deriveWorkspaceId(first)).to.equal(deriveWorkspaceId(first));
    expect(deriveWorkspaceId(first)).to.match(/^electron-docs-[0-9a-f]{16}$/u);
  });
});
