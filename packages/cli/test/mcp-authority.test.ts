import { expect } from 'chai';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpFileAuthority } from '../src/mcp/authority.js';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

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

  it('treats the legacy markdown string as content even when it names a readable file', async () => {
    let harness: McpHarness | null = null;
    try {
      harness = await startMcpHarness();
      const candidate = path.join(harness.tmpDir, 'looks-like-input.md');
      await writeFile(candidate, 'this file has several secret words');
      const result = await callTool(harness.client, 'analyze_markdown', { markdown: candidate });
      expect(result.isError).to.equal(false);
      const payload = JSON.parse(result.text) as { stats: { wordCount: number } };
      expect(payload.stats.wordCount).to.equal(1);
    } finally {
      await harness?.dispose();
    }
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
