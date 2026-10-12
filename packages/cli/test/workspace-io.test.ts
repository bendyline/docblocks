import { expect } from 'chai';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FsError, parseWorkspacePath, type WorkspacePath } from '@bendyline/docblocks/filesystem';
import { createNodeWorkspaceIO, type NodeWorkspaceIO } from '../src/internal/workspace-io.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (data: ArrayBuffer): string => new TextDecoder().decode(data);
const p = (value: string): WorkspacePath => parseWorkspacePath(value);
const DIRECTORY_LINK = process.platform === 'win32' ? 'junction' : 'dir';

describe('CLI Node workspace IO adapter', () => {
  let tempRoot = '';
  let workspace = '';
  let outside = '';
  let io: NodeWorkspaceIO;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-workspace-io-'));
    workspace = path.join(tempRoot, 'workspace');
    outside = path.join(tempRoot, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    io = await createNodeWorkspaceIO(workspace);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('lists deterministic snapshots and reads bytes with their version', async () => {
    await mkdir(path.join(workspace, 'b-folder'));
    await mkdir(path.join(workspace, 'a-folder'));
    await writeFile(path.join(workspace, 'b.md'), '# B');
    await writeFile(path.join(workspace, 'a.md'), '# A');

    const listing = await io.readDirectory(p(''));
    expect(listing.map((entry) => [entry.kind, entry.path])).to.deep.equal([
      ['directory', 'a-folder'],
      ['directory', 'b-folder'],
      ['file', 'a.md'],
      ['file', 'b.md'],
    ]);

    const read = await io.readFile(p('a.md'));
    expect(read).to.not.equal(null);
    expect(decode(read!.data)).to.equal('# A');
    expect(read!.entry.size).to.equal(3);
    expect(read!.entry.version).to.equal((await io.stat(p('a.md')))!.version);
    expect(listing.find((entry) => entry.path === 'a.md')!.version).to.equal(read!.entry.version);
  });

  it('distinguishes absence from wrong kinds', async () => {
    await writeFile(path.join(workspace, 'file.md'), 'x');
    await mkdir(path.join(workspace, 'folder'));

    expect(await io.stat(p('missing.md'))).to.equal(null);
    expect(await io.readFile(p('missing/inner.md'))).to.equal(null);
    expect(await io.readFile(p('file.md/inner.md'))).to.equal(null);
    expect(await captureFsError(io.readFile(p('folder')))).to.equal('type-mismatch');
    expect(await captureFsError(io.readDirectory(p('missing')))).to.equal('not-found');
    expect(await captureFsError(io.readDirectory(p('file.md')))).to.equal('type-mismatch');
    expect(await captureFsError(io.writeFile(p(''), encode('x')))).to.equal('invalid-path');
  });

  it('refuses paths that escape the root through a symbolic link', async () => {
    await writeFile(path.join(outside, 'secret.md'), '# Secret');
    await symlink(outside, path.join(workspace, 'linked'), DIRECTORY_LINK);
    await writeFile(path.join(workspace, 'visible.md'), '# Visible');

    const listing = await io.readDirectory(p(''));
    expect(listing.map((entry) => entry.path)).to.deep.equal(['visible.md']);
    expect(await captureFsError(io.readFile(p('linked/secret.md')))).to.equal('path-escape');
    expect(await captureFsError(io.stat(p('linked/secret.md')))).to.equal('path-escape');
    expect(
      await captureFsError(
        io.writeFile(p('linked/index.html'), encode('pwned'), { createParents: true }),
      ),
    ).to.equal('path-escape');
    expect(
      await captureFsError(
        io.writeFile(p('linked/new/index.html'), encode('pwned'), { createParents: true }),
      ),
    ).to.equal('path-escape');
    expect(await readdir(outside)).to.deep.equal(['secret.md']);
  });

  it('never follows or replaces a symbolic link named by the path', async function () {
    await writeFile(path.join(outside, 'target.html'), 'outside');
    try {
      await symlink(path.join(outside, 'target.html'), path.join(workspace, 'index.html'), 'file');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') this.skip();
      throw error;
    }

    expect(await captureFsError(io.stat(p('index.html')))).to.equal('not-supported');
    expect(await captureFsError(io.readFile(p('index.html')))).to.equal('not-supported');
    expect(await captureFsError(io.writeFile(p('index.html'), encode('replaced')))).to.equal(
      'not-supported',
    );
    expect(await readFile(path.join(outside, 'target.html'), 'utf8')).to.equal('outside');
  });

  it('enforces expected versions immediately before publishing', async () => {
    await writeFile(path.join(workspace, 'catalog.json'), '{"generator":"one"}');
    const read = await io.readFile(p('catalog.json'));
    // A concurrent writer changes the file after it was read.
    await writeFile(path.join(workspace, 'catalog.json'), '{"generator":"concurrent writer"}');

    const conflict = await captureError(
      io.writeFile(p('catalog.json'), encode('{"generator":"two"}'), {
        mode: 'replace',
        expectedVersion: read!.entry.version,
      }),
    );
    expect(conflict).to.be.instanceOf(FsError);
    expect((conflict as FsError).code).to.equal('conflict');
    expect(await readFile(path.join(workspace, 'catalog.json'), 'utf8')).to.equal(
      '{"generator":"concurrent writer"}',
    );

    const current = await io.stat(p('catalog.json'));
    const written = await io.writeFile(p('catalog.json'), encode('{"generator":"three"}'), {
      mode: 'replace',
      expectedVersion: current!.version,
    });
    expect(await readFile(path.join(workspace, 'catalog.json'), 'utf8')).to.equal(
      '{"generator":"three"}',
    );
    expect(written.version).to.equal((await io.stat(p('catalog.json')))!.version);
    expect(written.version).to.not.equal(current!.version);
    expect(await readdir(workspace)).to.deep.equal(['catalog.json']);
  });

  it('refuses create mode and null expected versions over an existing file', async () => {
    await writeFile(path.join(workspace, 'index.html'), 'hand-written');

    expect(
      await captureFsError(io.writeFile(p('index.html'), encode('generated'), { mode: 'create' })),
    ).to.equal('already-exists');
    expect(
      await captureFsError(
        io.writeFile(p('index.html'), encode('generated'), { expectedVersion: null }),
      ),
    ).to.equal('conflict');
    expect(
      await captureFsError(
        io.writeFile(p('missing.html'), encode('generated'), { mode: 'replace' }),
      ),
    ).to.equal('not-found');
    expect(await readFile(path.join(workspace, 'index.html'), 'utf8')).to.equal('hand-written');
    expect(await readdir(workspace)).to.deep.equal(['index.html']);
  });

  it('creates parents only when asked and publishes new files exclusively', async () => {
    expect(
      await captureFsError(
        io.writeFile(p('site/docs/index.html'), encode('page'), { mode: 'create' }),
      ),
    ).to.equal('not-found');

    const created = await io.writeFile(p('site/docs/index.html'), encode('page'), {
      mode: 'create',
      createParents: true,
      expectedVersion: null,
    });
    expect(created.kind).to.equal('file');
    expect(created.size).to.equal(4);
    expect(await readFile(path.join(workspace, 'site', 'docs', 'index.html'), 'utf8')).to.equal(
      'page',
    );
    expect(await readdir(path.join(workspace, 'site', 'docs'))).to.deep.equal(['index.html']);

    await writeFile(path.join(workspace, 'blocker'), 'file');
    expect(
      await captureFsError(
        io.writeFile(p('blocker/index.html'), encode('page'), { createParents: true }),
      ),
    ).to.equal('type-mismatch');
  });
});

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error: unknown) {
    return error;
  }
}

async function captureFsError(operation: Promise<unknown>): Promise<string | null> {
  const error = await captureError(operation);
  if (error === null) return null;
  if (!(error instanceof FsError)) throw error;
  return error.code;
}
