import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOpenRequests, resolveOpenUrl } from '../main/open-requests.js';
import { getWorkspaceRoots } from '../main/workspace-roots.js';

describe('desktop open request resolution', () => {
  const roots = getWorkspaceRoots();
  let workspaceRoot = '';
  let outsideRoot = '';
  let markdownFile = '';

  beforeEach(() => {
    roots._reset();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-open-'));
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-outside-'));
    fs.mkdirSync(path.join(workspaceRoot, 'notes'), { recursive: true });
    markdownFile = path.join(workspaceRoot, 'notes', 'today.md');
    fs.writeFileSync(markdownFile, '# Today');
    roots.register('ws-1', workspaceRoot);
  });

  afterEach(() => {
    roots._reset();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  it('converts a trusted markdown file path into a workspace file request', () => {
    expect(resolveOpenRequests([markdownFile])).to.deep.equal([
      { kind: 'workspace-file', workspaceId: 'ws-1', path: '/notes/today.md' },
    ]);
  });

  it('converts a docblocks URL path into a workspace file request', () => {
    const url = `docblocks://open?path=${encodeURIComponent(markdownFile)}`;

    expect(resolveOpenUrl(url)).to.deep.equal({
      kind: 'workspace-file',
      workspaceId: 'ws-1',
      path: '/notes/today.md',
    });
  });

  it('ignores markdown files outside registered workspaces', () => {
    const outsideFile = path.join(outsideRoot, 'private.md');
    fs.writeFileSync(outsideFile, '# Private');

    expect(resolveOpenRequests([outsideFile])).to.deep.equal([]);
  });

  it('ignores invalid or unsupported URLs', () => {
    expect(resolveOpenUrl('not a url')).to.equal(null);
    expect(resolveOpenUrl('https://example.com/?path=/notes/today.md')).to.equal(null);
  });
});
