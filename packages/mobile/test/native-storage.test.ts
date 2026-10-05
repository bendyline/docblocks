import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import { parseWorkspacePath } from '../../core/src/filesystem/workspace-path.js';
import { defineFileSystemProviderV2Conformance } from '../../core/test/helpers/filesystem-v2-conformance.js';
import { HostFileSystemProviderV2 } from '../../core/src/filesystem/host-provider-v2.js';
import {
  createMobileFileSystemBridge,
  MOBILE_STORAGE_LIMITS,
} from '../../core/src/host/mobile-wire.js';
import { parseFileSystemCapabilities } from '../../core/src/filesystem/capabilities.js';

const harness: string[] | undefined = process.env.DOCBLOCKS_NATIVE_COMMAND
  ? (JSON.parse(process.env.DOCBLOCKS_NATIVE_COMMAND) as string[])
  : process.env.DOCBLOCKS_SWIFT_HARNESS
    ? [process.env.DOCBLOCKS_SWIFT_HARNESS]
    : undefined;
const capabilities = parseFileSystemCapabilities({
  writeAtomicity: 'process',
  moveAtomicity: 'process',
  snapshotAtomicity: 'process',
  conditionalWrite: 'process',
  recursiveRemove: true,
  watch: false,
  caseSensitivity: 'platform',
  symlinkPolicy: 'reject',
  durability: 'best-effort',
});
const nativeDescribe = harness ? describe : describe.skip;
nativeDescribe('real mobile native storage', () => {
  let processes: ChildProcessWithoutNullStreams[] = [];
  let directories: string[] = [];
  afterEach(async () => {
    for (const child of processes) child.stdin.end();
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    processes = [];
    directories = [];
  });
  const makeProvider = async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'docblocks-mobile-test-'));
    directories.push(directory);
    const child = spawn(harness![0], [...harness!.slice(1), directory]);
    processes.push(child);
    child.stderr.resume();
    const pending: { resolve: (value: unknown) => void; reject: (reason: Error) => void }[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => {
      const next = pending.shift();
      if (!next) throw new Error('Unsolicited native reply');
      try {
        next.resolve(JSON.parse(line));
      } catch (error) {
        next.reject(error as Error);
      }
    });
    child.on('error', (error) => pending.splice(0).forEach((request) => request.reject(error)));
    child.on('exit', (code) =>
      pending
        .splice(0)
        .forEach((request) => request.reject(new Error(`Native harness exited ${code}`))),
    );
    const bridge = createMobileFileSystemBridge(
      (request) =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
          child.stdin.write(`${JSON.stringify(request)}\n`);
        }),
      capabilities,
    );
    return new HostFileSystemProviderV2('local', 'Native test', 'Test documents', {
      capabilities,
      limits: MOBILE_STORAGE_LIMITS,
      transport: bridge,
    });
  };
  defineFileSystemProviderV2Conformance('Native storage', makeProvider);
  it('round-trips multiple bridge chunks and releases transfer slots', async () => {
    const provider = await makeProvider();
    try {
      const bytes = Uint8Array.from(
        { length: 3 * MOBILE_STORAGE_LIMITS.chunkBytes + 13 },
        (_, index) => index % 251,
      );
      const path = parseWorkspacePath('large.bin');
      for (let index = 0; index < 5; index++) {
        await provider.writeFile(path, bytes);
        expect(new Uint8Array((await provider.readFile(path))!.data)).to.deep.equal(bytes);
      }
      const file = (await provider.snapshot()).entries.find((entry) => entry.path === path);
      expect(file?.kind).to.equal('file');
      if (file?.kind === 'file') expect(new Uint8Array(file.data)).to.deep.equal(bytes);
    } finally {
      await provider.dispose();
    }
  });
});

describe('mobile native wire', () => {
  it('fails closed on unknown response fields', async () => {
    const bridge = createMobileFileSystemBridge(
      async () => ({ ok: true, value: null, extra: true }),
      capabilities,
    );
    await bridge.stat('instance', parseWorkspacePath('')).then(
      () => expect.fail('accepted malformed response'),
      (error: unknown) => expect(error).to.be.instanceOf(Error),
    );
  });
});
