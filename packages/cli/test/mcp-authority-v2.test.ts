import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import { McpFileAuthority } from '../src/mcp/authority.js';

describe('MCP root aliases and safe materialization', function () {
  this.timeout(10_000);

  let root = '';
  let allowed = '';
  let outside = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-mcp-authority-v2-'));
    allowed = path.join(root, 'allowed');
    outside = path.join(root, 'outside');
    await mkdir(path.join(allowed, 'nested'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(allowed, 'nested', 'input.md'), '# Allowed', 'utf8');
    await writeFile(path.join(outside, 'secret.md'), '# Secret', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('publishes stable opaque root aliases with least-privilege capability flags', async () => {
    const readOnly = path.join(root, 'read-only');
    const writeOnly = path.join(root, 'write-only');
    await mkdir(readOnly);
    await mkdir(writeOnly);
    const authority = await McpFileAuthority.create({
      readRoots: [allowed, readOnly, allowed],
      writeRoots: [allowed, writeOnly],
    });

    const roots = authority.listRoots();
    expect(roots).to.have.length(3);
    expect(roots.map((descriptor) => descriptor.id)).to.deep.equal(
      [...roots.map((descriptor) => descriptor.id)].sort(),
    );
    expect(roots.every((descriptor) => /^root-[a-f0-9]{16}$/u.test(descriptor.id))).to.equal(true);
    expect(roots).to.deep.include({
      id: roots.find((descriptor) => descriptor.label === 'allowed')?.id,
      label: 'allowed',
      read: true,
      write: true,
    });
    expect(roots.find((descriptor) => descriptor.label === 'read-only')).to.include({
      read: true,
      write: false,
    });
    expect(roots.find((descriptor) => descriptor.label === 'write-only')).to.include({
      read: false,
      write: true,
    });
    expect(JSON.stringify(roots)).to.not.include(await realpath(allowed));
  });

  it('sanitizes root labels for bounded MCP wire output without changing opaque ids', async () => {
    const unsafeRoot = path.join(root, 'unsafe\u007flabel');
    await mkdir(unsafeRoot);
    const authority = await McpFileAuthority.create({ readRoots: [unsafeRoot] });

    const [descriptor] = authority.listRoots();
    expect(descriptor).to.include({ label: 'unsafelabel', read: true, write: false });
    expect(descriptor?.id).to.match(/^root-[a-f0-9]{16}$/u);
    expect(descriptor?.label).to.not.include('\u0000').and.not.include('\u007f');
    expect(descriptor?.label.length ?? 0).to.be.within(1, 1_024);
  });

  it('resolves safe root-relative reads and writes without expanding startup authority', async () => {
    const authority = await McpFileAuthority.create({
      readRoots: [allowed],
      writeRoots: [allowed],
    });
    const rootId = authority.listRoots()[0].id;

    expect(await authority.authorizeRootRead(rootId, 'nested/input.md')).to.equal(
      await realpath(path.join(allowed, 'nested', 'input.md')),
    );
    expect(await authority.authorizeRootWrite(rootId, 'nested/output.bin')).to.equal(
      path.join(await realpath(path.join(allowed, 'nested')), 'output.bin'),
    );
    await expectFailure(
      authority.authorizeRootRead('root-0000000000000000', 'nested/input.md'),
      'unknown',
    );
    await expectFailure(
      authority.authorizeRootWrite('root-0000000000000000', 'output.bin'),
      'unknown',
    );
    await expectFailure(authority.authorizeRootWrite(rootId, 'missing/output.bin'), 'parent');
  });

  it('rejects traversal, absolute paths, platform aliases, and symlink escapes', async () => {
    await symlink(
      outside,
      path.join(allowed, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const authority = await McpFileAuthority.create({
      readRoots: [allowed],
      writeRoots: [allowed],
    });
    const rootId = authority.listRoots()[0].id;
    const invalidPaths = [
      '',
      '.',
      '../outside/secret.md',
      'nested/../input.md',
      '/absolute.md',
      'C:/absolute.md',
      'nested\\input.md',
      'nested//input.md',
      'nested/./input.md',
      'nested/control\u0001.md',
    ];

    for (const workspacePath of invalidPaths) {
      await expectFailure(authority.authorizeRootRead(rootId, workspacePath), 'invalid');
      await expectFailure(authority.authorizeRootWrite(rootId, workspacePath), 'invalid');
    }
    await expectFailure(authority.authorizeRootRead(rootId, 'escape/secret.md'), 'outside');
    await expectFailure(authority.authorizeRootWrite(rootId, 'escape/output.md'), 'outside');
  });

  it('cancels a contained input read between bounded chunks and closes its descriptor', async () => {
    const target = path.join(allowed, 'nested', 'large-input.bin');
    const moved = path.join(allowed, 'nested', 'moved-input.bin');
    const content = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    await writeFile(target, content);
    const controller = new AbortController();
    const reason = new Error('cancel contained input read');
    const observations: Array<{ read: number; total: number }> = [];
    const authority = await McpFileAuthority.create(
      { readRoots: [allowed] },
      {
        afterInputReadChunk(read, total) {
          observations.push({ read, total });
          controller.abort(reason);
        },
      },
    );

    await expectRejectionReason(authority.readFile(target, controller.signal), reason);
    expect(observations).to.have.length(1);
    expect(observations[0]?.read).to.be.greaterThan(0).and.lessThan(content.byteLength);
    expect(observations[0]?.total).to.equal(content.byteLength);
    await rename(target, moved);
    await rename(moved, target);
  });

  it('defaults to atomic no-replace publication and keeps an existing target unchanged', async () => {
    const target = path.join(allowed, 'result.bin');
    await writeFile(target, 'original', 'utf8');
    const authority = await McpFileAuthority.create({ writeRoots: [allowed] });

    await expectFailure(
      authority.materializeBytes(target, Buffer.from('replacement'), 64),
      'already exists',
    );
    expect(await readFile(target, 'utf8')).to.equal('original');
  });

  it('allows exactly one concurrent no-replace publication to an absent target', async () => {
    const target = path.join(allowed, 'winner.bin');
    const authority = await McpFileAuthority.create({ writeRoots: [allowed] });

    const settled = await Promise.allSettled([
      authority.materializeBytes(target, Buffer.from('alpha'), 64),
      authority.materializeBytes(target, Buffer.from('bravo'), 64),
      authority.materializeBytes(target, Buffer.from('charlie'), 64),
    ]);
    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    const rejected = settled.filter((result) => result.status === 'rejected');

    expect(fulfilled).to.have.length(1);
    expect(rejected).to.have.length(2);
    expect(['alpha', 'bravo', 'charlie']).to.include(await readFile(target, 'utf8'));
  });

  it('replaces only when the current bytes match the expected SHA-256', async () => {
    const target = path.join(allowed, 'conditional.bin');
    await writeFile(target, 'baseline', 'utf8');
    const authority = await McpFileAuthority.create({ writeRoots: [allowed] });
    const baselineHash = sha256('baseline');

    await expectFailure(
      authority.materializeBytes(target, Buffer.from('wrong'), 64, {
        ifExists: 'replace',
        expectedSha256: '0'.repeat(64),
      }),
      'precondition',
    );
    expect(await readFile(target, 'utf8')).to.equal('baseline');

    await authority.materializeBytes(target, Buffer.from('replacement'), 64, {
      ifExists: 'replace',
      expectedSha256: baselineHash.toUpperCase(),
    });
    expect(await readFile(target, 'utf8')).to.equal('replacement');
  });

  it('rejects a stale expected hash after an intervening writer changes the target', async () => {
    const target = path.join(allowed, 'stale.bin');
    await writeFile(target, 'baseline', 'utf8');
    const authority = await McpFileAuthority.create({ writeRoots: [allowed] });
    const staleHash = sha256('baseline');
    await writeFile(target, 'intervening writer', 'utf8');

    await expectFailure(
      authority.materializeBytes(target, Buffer.from('replacement'), 64, {
        ifExists: 'replace',
        expectedSha256: staleHash,
      }),
      'precondition',
    );
    expect(await readFile(target, 'utf8')).to.equal('intervening writer');
  });

  it('revalidates the expected hash after staging and preserves an intervening writer', async () => {
    const target = path.join(allowed, 'staged-race.bin');
    await writeFile(target, 'baseline', 'utf8');
    const staged = deferred<void>();
    const release = deferred<void>();
    const authority = await McpFileAuthority.create(
      { writeRoots: [allowed] },
      {
        afterMaterializationStage: async () => {
          staged.resolve();
          await release.promise;
        },
      },
    );

    const pending = authority.materializeBytes(target, Buffer.from('replacement'), 64, {
      ifExists: 'replace',
      expectedSha256: sha256('baseline'),
    });
    await staged.promise;
    await writeFile(target, 'intervening writer', 'utf8');
    release.resolve();

    await expectFailure(pending, 'precondition');
    expect(await readFile(target, 'utf8')).to.equal('intervening writer');
    expect((await readdir(allowed)).filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
  });

  it('rejects no-replace publication when the staged parent is swapped for an outside link', async () => {
    const target = path.join(allowed, 'nested', 'escaped-create.bin');
    const parkedParent = path.join(allowed, 'parked-create-parent');
    const authority = await McpFileAuthority.create(
      { writeRoots: [allowed] },
      {
        afterMaterializationStage: (temporaryPath) =>
          swapStagedParentForOutsideLink(temporaryPath, parkedParent, outside),
      },
    );

    await expectFailure(authority.materializeBytes(target, Buffer.from('escape'), 64), 'parent');
    await expectFailure(readFile(path.join(outside, 'escaped-create.bin')), 'enoent');
    expect((await readdir(outside)).filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
  });

  it('rejects conditional replacement when the staged parent is swapped for an outside link', async () => {
    const target = path.join(allowed, 'nested', 'escaped-replace.bin');
    const outsideTarget = path.join(outside, 'escaped-replace.bin');
    const parkedParent = path.join(allowed, 'parked-replace-parent');
    await writeFile(target, 'baseline', 'utf8');
    // Matching bytes ensure the post-stage hash check succeeds through the
    // swapped link; containment revalidation must be what blocks publication.
    await writeFile(outsideTarget, 'baseline', 'utf8');
    const authority = await McpFileAuthority.create(
      { writeRoots: [allowed] },
      {
        afterMaterializationStage: (temporaryPath) =>
          swapStagedParentForOutsideLink(temporaryPath, parkedParent, outside),
      },
    );

    await expectFailure(
      authority.materializeBytes(target, Buffer.from('escape'), 64, {
        ifExists: 'replace',
        expectedSha256: sha256('baseline'),
      }),
      'parent',
    );
    expect(await readFile(outsideTarget, 'utf8')).to.equal('baseline');
    expect(await readFile(path.join(parkedParent, 'escaped-replace.bin'), 'utf8')).to.equal(
      'baseline',
    );
    expect((await readdir(outside)).filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
  });

  it('preserves the exact cancellation reason during a bounded staged write', async () => {
    const target = path.join(allowed, 'mid-write.bin');
    const content = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    const controller = new AbortController();
    const reason = new Error('cancel during staged write');
    const observations: Array<{ written: number; total: number }> = [];
    const authority = await McpFileAuthority.create(
      { writeRoots: [allowed] },
      {
        afterMaterializationWriteChunk: (written, total) => {
          observations.push({ written, total });
          controller.abort(reason);
        },
      },
    );

    await expectRejectionReason(
      authority.materializeBytes(target, content, content.byteLength, {
        signal: controller.signal,
      }),
      reason,
    );
    expect(observations).to.have.length(1);
    expect(observations[0]?.written).to.be.greaterThan(0).and.lessThan(content.byteLength);
    expect(observations[0]?.total).to.equal(content.byteLength);
    await expectFailure(readFile(target), 'enoent');
    expect((await readdir(allowed)).filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
  });

  it('preserves the exact cancellation reason during a bounded precondition hash', async () => {
    const target = path.join(allowed, 'mid-hash.bin');
    const baseline = Buffer.alloc(2 * 64 * 1024 + 1, 0x62);
    await writeFile(target, baseline);
    const controller = new AbortController();
    const reason = new Error('cancel during precondition hash');
    const observations: Array<{ read: number; total: number }> = [];
    const authority = await McpFileAuthority.create(
      { writeRoots: [allowed] },
      {
        afterMaterializationHashChunk: (read, total) => {
          observations.push({ read, total });
          controller.abort(reason);
        },
      },
    );

    await expectRejectionReason(
      authority.materializeBytes(target, Buffer.from('replacement'), 64, {
        ifExists: 'replace',
        expectedSha256: sha256(baseline),
        signal: controller.signal,
      }),
      reason,
    );
    expect(observations).to.have.length(1);
    expect(observations[0]?.read).to.be.greaterThan(0).and.lessThan(baseline.byteLength);
    expect(observations[0]?.total).to.equal(baseline.byteLength);
    expect(await readFile(target)).to.deep.equal(baseline);
    expect((await readdir(allowed)).filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
  });

  for (const mode of ['no-replace', 'conditional-replace'] as const) {
    it(`treats ${mode} publication as the cancellation commit boundary`, async () => {
      const target = path.join(allowed, `${mode}.bin`);
      if (mode === 'conditional-replace') await writeFile(target, 'baseline', 'utf8');
      const controller = new AbortController();
      const reason = new Error('cancel at publication boundary');
      let publishedPath: string | undefined;
      const authority = await McpFileAuthority.create(
        { writeRoots: [allowed] },
        {
          afterMaterializationPublish: (value) => {
            publishedPath = value;
            controller.abort(reason);
          },
        },
      );

      const result =
        mode === 'conditional-replace'
          ? await authority.materializeBytes(target, Buffer.from('published'), 64, {
              ifExists: 'replace',
              expectedSha256: sha256('baseline'),
              signal: controller.signal,
            })
          : await authority.materializeBytes(target, Buffer.from('published'), 64, {
              signal: controller.signal,
            });

      expect(result).to.equal(target);
      expect(publishedPath).to.equal(target);
      expect(controller.signal.aborted).to.equal(true);
      expect(controller.signal.reason).to.equal(reason);
      expect(await readFile(target, 'utf8')).to.equal('published');
    });
  }

  it('cancels staged materialization before publication and removes the temporary file', async () => {
    const target = path.join(allowed, 'cancelled-replacement.bin');
    await writeFile(target, 'baseline', 'utf8');
    const staged = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const reason = new Error('materialization cancelled');
    const authority = await McpFileAuthority.create(
      { writeRoots: [allowed] },
      {
        afterMaterializationStage: async () => {
          staged.resolve();
          await release.promise;
        },
      },
    );

    const pending = authority.materializeBytes(target, Buffer.from('replacement'), 64, {
      ifExists: 'replace',
      expectedSha256: sha256('baseline'),
      signal: controller.signal,
    });
    await staged.promise;
    controller.abort(reason);
    release.resolve();

    let caught: unknown;
    try {
      await pending;
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.equal(reason);
    expect(await readFile(target, 'utf8')).to.equal('baseline');
    expect((await readdir(allowed)).filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
  });

  it('streams conditional hashes within the configured input budget', async () => {
    const target = path.join(allowed, 'oversized-precondition.bin');
    await writeFile(target, '12345', 'utf8');
    const authority = await McpFileAuthority.create({
      writeRoots: [allowed],
      maxInputFileBytes: 4,
    });

    await expectFailure(
      authority.materializeBytes(target, Buffer.from('new'), 64, {
        ifExists: 'replace',
        expectedSha256: sha256('12345'),
      }),
      'file-size limit',
    );
    expect(await readFile(target, 'utf8')).to.equal('12345');
  });

  it('serializes concurrent conditional replacements so one baseline can win once', async () => {
    const target = path.join(allowed, 'conditional-race.bin');
    await writeFile(target, 'baseline', 'utf8');
    const authority = await McpFileAuthority.create({ writeRoots: [allowed] });
    const expectedSha256 = sha256('baseline');

    const settled = await Promise.allSettled([
      authority.materializeBytes(target, Buffer.from('first'), 64, {
        ifExists: 'replace',
        expectedSha256,
      }),
      authority.materializeBytes(target, Buffer.from('second'), 64, {
        ifExists: 'replace',
        expectedSha256,
      }),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).to.have.length(1);
    expect(settled.filter((result) => result.status === 'rejected')).to.have.length(1);
    expect(['first', 'second']).to.include(await readFile(target, 'utf8'));
  });

  it('rejects invalid hashes and over-budget materialization before publishing output', async () => {
    const target = path.join(allowed, 'bounded.bin');
    const authority = await McpFileAuthority.create({ writeRoots: [allowed] });

    await expectFailure(
      authority.materializeBytes(target, Buffer.from('abc'), 3, {
        ifExists: 'replace',
        expectedSha256: 'not-a-hash',
      }),
      'sha-256',
    );
    await expectFailure(authority.materializeBytes(target, Buffer.from('abcd'), 3), 'limit');
    await expectFailure(
      authority.materializeBytes(target, Buffer.from('abc'), 3, {
        ifExists: 'replace',
        expectedSha256: sha256('missing'),
      }),
      'precondition',
    );
    await expectFailure(readFile(target), 'enoent');
  });
});

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function swapStagedParentForOutsideLink(
  temporaryPath: string,
  parkedParent: string,
  outsideDirectory: string,
): Promise<void> {
  const authorizedParent = path.dirname(temporaryPath);
  await rename(authorizedParent, parkedParent);
  // Windows directory symlinks generally require elevation, while junctions
  // do not. Both junctions and Unix `dir` symlinks are reported by lstat and
  // resolved by realpath, so they exercise the same containment boundary.
  await symlink(
    outsideDirectory,
    authorizedParent,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await rename(
    path.join(parkedParent, path.basename(temporaryPath)),
    path.join(outsideDirectory, path.basename(temporaryPath)),
  );
}

async function expectRejectionReason(promise: Promise<unknown>, reason: unknown): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).to.equal(reason);
}

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message.toLowerCase()).to.contain(message.toLowerCase());
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}
