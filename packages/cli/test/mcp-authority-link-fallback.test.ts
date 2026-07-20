import { expect } from 'chai';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpFileAuthority } from '../src/mcp/authority.js';
import { isLinkUnsupportedError } from '../src/internal/link-support.js';

function errno(code: string, message = `${code}: simulated`): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

/** Stand in for a volume with no hard-link support (FAT32/exFAT, some SMB). */
function linkless(code: string): (existingPath: string, newPath: string) => Promise<void> {
  return async () => {
    throw errno(code, `${code}: operation not permitted, link`);
  };
}

describe('link-unsupported classification', () => {
  it('treats only "no link primitive" errnos as a fallback signal', () => {
    for (const code of ['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']) {
      expect(isLinkUnsupportedError(errno(code)), code).to.equal(true);
    }
  });

  it('never treats an occupied target or a real permission denial as unsupported', () => {
    // EEXIST must refuse, never fall back — falling back would be a clobber.
    expect(isLinkUnsupportedError(errno('EEXIST'))).to.equal(false);
    expect(isLinkUnsupportedError(errno('EACCES'))).to.equal(false);
    expect(isLinkUnsupportedError(errno('ENOENT'))).to.equal(false);
    expect(isLinkUnsupportedError(new Error('not an errno'))).to.equal(false);
    expect(isLinkUnsupportedError(null)).to.equal(false);
  });
});

describe('McpFileAuthority create-mode publication without hard links', () => {
  let root = '';

  beforeEach(async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-linkless-'));
    // macOS exposes the same temp directory through /var and /private/var.
    // The authority returns the physically canonicalized target path.
    root = await realpath(temporaryRoot);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const authorityWithLink = async (
    link?: (existingPath: string, newPath: string) => Promise<void>,
  ): Promise<McpFileAuthority> =>
    McpFileAuthority.create({ readRoots: [root], writeRoots: [root] }, link ? { link } : {});

  for (const code of ['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']) {
    it(`publishes through an exclusive create when link() reports ${code}`, async () => {
      const authority = await authorityWithLink(linkless(code));
      const target = path.join(root, 'artifact.bin');
      const content = new Uint8Array([1, 2, 3, 4, 5]);

      const published = await authority.materializeBytes(target, content, 1024);

      expect(published).to.equal(target);
      expect(new Uint8Array(await readFile(target))).to.deep.equal(content);
      // The operation-owned temporary is still cleaned up on the fallback path.
      expect(await readdir(root)).to.deep.equal(['artifact.bin']);
    });
  }

  it('still refuses an occupied target on a filesystem without hard links', async () => {
    const target = path.join(root, 'artifact.bin');
    await writeFile(target, 'existing');
    const authority = await authorityWithLink(linkless('EPERM'));

    let failure: unknown;
    try {
      await authority.materializeBytes(target, new Uint8Array([9, 9]), 1024);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.equal('MCP output already exists');
    // The existing file survives untouched: the fallback never clobbers.
    expect(await readFile(target, 'utf8')).to.equal('existing');
  });

  it('refuses when the target appears after staging, without falling back', async () => {
    const target = path.join(root, 'artifact.bin');
    const authority = await McpFileAuthority.create(
      { readRoots: [root], writeRoots: [root] },
      {
        // Win the race: occupy the target after staging, then report EEXIST
        // exactly as a real link() against an occupied name would.
        link: async () => {
          await writeFile(target, 'someone else');
          throw errno('EEXIST', 'EEXIST: file already exists, link');
        },
      },
    );

    let failure: unknown;
    try {
      await authority.materializeBytes(target, new Uint8Array([7]), 1024);
    } catch (error: unknown) {
      failure = error;
    }

    expect((failure as Error).message).to.equal('MCP output already exists');
    expect(await readFile(target, 'utf8')).to.equal('someone else');
  });

  it('surfaces an unrelated link failure rather than masking it with a fallback', async () => {
    const authority = await authorityWithLink(async () => {
      throw errno('EIO', 'EIO: i/o error, link');
    });

    let failure: unknown;
    try {
      await authority.materializeBytes(path.join(root, 'artifact.bin'), new Uint8Array([1]), 1024);
    } catch (error: unknown) {
      failure = error;
    }

    expect((failure as NodeJS.ErrnoException).code).to.equal('EIO');
    expect(await readdir(root)).to.deep.equal([]);
  });

  it('leaves no partial publication when the fallback write is cancelled', async () => {
    const controller = new AbortController();
    const target = path.join(root, 'artifact.bin');
    const authority = await McpFileAuthority.create(
      { readRoots: [root], writeRoots: [root] },
      {
        link: linkless('EPERM'),
        afterMaterializationWriteChunk: () => {
          controller.abort();
        },
      },
    );

    let failure: unknown;
    try {
      await authority.materializeBytes(target, new Uint8Array([1, 2, 3]), 1024, {
        signal: controller.signal,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    // The reservation this run created is removed, not left as an empty file.
    expect(await readdir(root)).to.deep.equal([]);
  });
});
