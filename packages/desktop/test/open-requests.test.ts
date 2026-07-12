import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOpenRequests, resolveOpenUrl, sendOpenRequest } from '../main/open-requests.js';
import { getWorkspaceRoots } from '../main/workspace-roots.js';
import type { BrowserWindow } from 'electron';

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

  it('opens a markdown file outside registered workspaces as a transient external file', () => {
    const outsideFile = path.join(outsideRoot, 'private.md');
    fs.writeFileSync(outsideFile, '# Private');

    expect(resolveOpenRequests([outsideFile])).to.deep.equal([
      { kind: 'external-file', absolutePath: outsideFile, name: 'private.md' },
    ]);
  });

  it('opens a .dbk bundle as an external bundle request (even inside a workspace)', () => {
    const bundle = path.join(workspaceRoot, 'notes', 'deck.dbk');
    fs.writeFileSync(bundle, 'PK');

    expect(resolveOpenRequests([bundle])).to.deep.equal([
      { kind: 'external-bundle', absolutePath: bundle, name: 'deck.dbk' },
    ]);
  });

  it('ignores invalid or unsupported URLs', () => {
    expect(resolveOpenUrl('not a url')).to.equal(null);
    expect(resolveOpenUrl('https://example.com/?path=/notes/today.md')).to.equal(null);
  });

  it('fails closed when an external file disappears before its grant is minted', () => {
    const disappeared = path.join(outsideRoot, 'disappeared.md');
    const sent: unknown[][] = [];
    const win = {
      webContents: {
        id: 1234,
        send: (...args: unknown[]) => sent.push(args),
      },
    } as unknown as BrowserWindow;

    expect(
      sendOpenRequest(win, {
        kind: 'external-file',
        absolutePath: disappeared,
        name: 'disappeared.md',
      }),
    ).to.equal(false);
    expect(sent).to.deep.equal([]);

    expect(
      sendOpenRequest(win, {
        kind: 'workspace-file',
        workspaceId: 'ws-1',
        path: '/notes/today.md',
      }),
    ).to.equal(true);
    expect(sent).to.deep.equal([
      ['open-request', { kind: 'workspace-file', workspaceId: 'ws-1', path: '/notes/today.md' }],
    ]);
  });
});
