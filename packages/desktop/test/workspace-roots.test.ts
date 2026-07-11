/**
 * Security-critical test: the WorkspaceRoots whitelist must reject any
 * path that escapes its registered root (`..` traversal, symlink-like
 * tricks via separators, absolute paths).
 *
 * This is the boundary that prevents a compromised renderer from
 * reading arbitrary files.
 */

import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deleteWorkspaceEntry } from '../main/workspace-file-operations.js';
import { getWorkspaceRoots, isPathInside } from '../main/workspace-roots.js';

async function expectFailure(operation: Promise<unknown>, message: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(Error);
  expect((failure as Error).message).to.match(message);
}

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

  it('resolves an opaque workspace id without accepting a renderer path', () => {
    expect(roots.get('ws-1')).to.deep.equal({ id: 'ws-1', rootPath: path.resolve(ROOT) });
    expect(roots.get(ROOT)).to.equal(null);
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

  it('does not reject legitimate child names that start with two dots', () => {
    const resolved = roots.resolve(ROOT, '/..notes/today.md');
    expect(resolved).to.equal(path.resolve(ROOT, '..notes/today.md'));
  });

  it('does not treat sibling paths with the same string prefix as inside', () => {
    const root = path.resolve('/tmp/docblocks');
    const sibling = path.resolve('/tmp/docblocks-other/index.html');
    expect(isPathInside(root, sibling)).to.equal(false);
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

describe('WorkspaceRoots physical containment', () => {
  const roots = getWorkspaceRoots();
  let container = '';
  let workspace = '';
  let outside = '';

  beforeEach(async () => {
    roots._reset();
    container = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-roots-'));
    workspace = path.join(container, 'workspace');
    outside = path.join(container, 'outside');
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.md'), 'outside');
    roots.register('physical-ws', workspace);
  });

  afterEach(async () => {
    roots._reset();
    await fs.rm(container, { recursive: true, force: true });
  });

  async function createEscapingDirectoryLink(): Promise<string> {
    const link = path.join(workspace, 'escape');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    return link;
  }

  it('rejects an existing path reached through a symlink or junction', async () => {
    await createEscapingDirectoryLink();

    await expectFailure(roots.resolvePhysical(workspace, '/escape/secret.md'), /symbolic link/i);
  });

  it('validates the nearest existing ancestor before creating a path', async () => {
    await createEscapingDirectoryLink();

    await expectFailure(
      roots.resolveMutation(workspace, '/escape/new/deep/note.md'),
      /symbolic link/i,
    );
    expect(await fs.readdir(outside)).to.deep.equal(['secret.md']);
  });

  it('allows creation below a missing path whose nearest ancestor is inside the root', async () => {
    const resolved = await roots.resolveMutation(workspace, '/new/deep/note.md');
    expect(resolved).to.equal(path.join(workspace, 'new', 'deep', 'note.md'));
  });

  it('rejects a registered root that is later retargeted', async () => {
    const originalWorkspace = path.join(container, 'original-workspace');
    await fs.rename(workspace, originalWorkspace);
    await fs.symlink(outside, workspace, process.platform === 'win32' ? 'junction' : 'dir');

    await expectFailure(roots.resolvePhysical(workspace, '/secret.md'), /changed physical target/i);
  });

  it('rejects deleting the registered workspace root and leaves it intact', async () => {
    await expectFailure(deleteWorkspaceEntry(roots, workspace, '/'), /root cannot be mutated/i);

    expect((await fs.stat(workspace)).isDirectory()).to.equal(true);
    expect(await fs.readFile(path.join(outside, 'secret.md'), 'utf8')).to.equal('outside');
  });
});
