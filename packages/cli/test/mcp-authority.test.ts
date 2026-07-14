import { expect } from 'chai';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCP_FILE_AUTHORITY_LIMITS, McpFileAuthority } from '../src/mcp/authority.js';

describe('MCP authority boundary', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-mcp-authority-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('denies reads and writes outside configured roots', async () => {
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.md'), 'secret');
    const authority = await McpFileAuthority.create({
      readRoots: [allowed],
      writeRoots: [allowed],
    });

    await expectFailure(authority.authorizeRead(path.join(outside, 'secret.md')), 'outside');
    await expectFailure(authority.authorizeWrite(path.join(outside, 'new.md')), 'outside');
  });

  it('rejects an outside target reached through a symlink or junction', async () => {
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.md'), 'secret');
    await symlink(
      outside,
      path.join(allowed, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const authority = await McpFileAuthority.create({
      readRoots: [allowed],
      writeRoots: [allowed],
    });

    await expectFailure(
      authority.authorizeRead(path.join(allowed, 'linked', 'secret.md')),
      'outside',
    );
    await expectFailure(
      authority.authorizeWrite(path.join(allowed, 'linked', 'new.md')),
      'outside',
    );
  });

  it('anchors output below the physical parent and rejects Windows alias filenames', async () => {
    const allowed = path.join(root, 'allowed');
    const physical = path.join(allowed, 'physical');
    await mkdir(physical, { recursive: true });
    await symlink(
      physical,
      path.join(allowed, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const authority = await McpFileAuthority.create({ writeRoots: [allowed] });

    expect(await authority.authorizeWrite(path.join(allowed, 'linked', 'result.md'))).to.equal(
      path.join(await realpath(physical), 'result.md'),
    );
    await expectFailure(authority.authorizeWrite(path.join(allowed, 'NUL.txt')), 'portable');
    await expectFailure(authority.authorizeWrite(path.join(allowed, 'note.md:secret')), 'portable');
  });

  it('enforces startup ceilings for input bytes and configured roots', async () => {
    await expectFailure(
      McpFileAuthority.create({
        maxInputFileBytes: MCP_FILE_AUTHORITY_LIMITS.maxInputFileBytes + 1,
      }),
      'input file limit',
    );
    await expectFailure(
      McpFileAuthority.create({
        readRoots: Array.from(
          { length: MCP_FILE_AUTHORITY_LIMITS.maxRootsPerCapability + 1 },
          () => root,
        ),
      }),
      'too many configured roots',
    );
    await expectFailure(
      McpFileAuthority.create({
        writeRoots: Array.from(
          { length: MCP_FILE_AUTHORITY_LIMITS.maxRootsPerCapability + 1 },
          () => root,
        ),
      }),
      'too many configured roots',
    );
  });
});

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message.toLowerCase()).to.contain(message);
}
