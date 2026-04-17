/**
 * Security-critical test: the WorkspaceRoots whitelist must reject any
 * path that escapes its registered root (`..` traversal, symlink-like
 * tricks via separators, absolute paths).
 *
 * This is the boundary that prevents a compromised renderer from
 * reading arbitrary files.
 */

import { expect } from 'chai';
import path from 'node:path';
import { getWorkspaceRoots } from '../main/workspace-roots.js';

describe('WorkspaceRoots path-traversal guard', () => {
  const roots = getWorkspaceRoots();
  const ROOT = '/tmp/docblocks-test';

  beforeEach(() => {
    roots._reset();
    roots.register('ws-1', ROOT);
  });

  it('resolves simple relative paths inside the root', () => {
    const resolved = roots.resolve(ROOT, '/notes/today.md');
    expect(resolved).to.equal(path.resolve(ROOT, 'notes/today.md'));
  });

  it('rejects paths that escape the root via ..', () => {
    expect(() => roots.resolve(ROOT, '/../etc/passwd')).to.throw(/escape/i);
    expect(() => roots.resolve(ROOT, '../../etc/passwd')).to.throw(/escape/i);
    expect(() => roots.resolve(ROOT, '/notes/../../etc/passwd')).to.throw(/escape/i);
  });

  it('rejects unregistered roots even if the relative path is safe', () => {
    expect(() => roots.resolve('/some/other/root', '/file.md')).to.throw(/not registered/i);
  });

  it('accepts nested paths deep inside the root', () => {
    const resolved = roots.resolve(ROOT, '/a/b/c/d/e.md');
    expect(resolved.startsWith(path.resolve(ROOT))).to.equal(true);
  });

  it('unregister removes the root from the whitelist', () => {
    roots.unregister('ws-1');
    expect(() => roots.resolve(ROOT, '/file.md')).to.throw(/not registered/i);
  });

  it('normalizes rootPath with trailing slashes', () => {
    roots.register('ws-2', ROOT + '/');
    const resolved = roots.resolve(ROOT, '/foo.md');
    expect(resolved).to.equal(path.resolve(ROOT, 'foo.md'));
  });
});
