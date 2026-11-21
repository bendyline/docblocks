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
  parseMobileExportRequest,
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
  it('lists a workspace from metadata without reading a file, as the index walks it', async () => {
    const provider = await makeProvider();
    const p = parseWorkspacePath;
    const encode = (text: string) => new TextEncoder().encode(text);
    try {
      await provider.writeFile(p('notes/deep/b.md'), encode('# B'), { createParents: true });
      await provider.writeFile(p('notes/a.md'), encode('# A'));
      await provider.writeFile(p('node_modules/pkg/index.js'), encode('x'), {
        createParents: true,
      });
      await provider.writeFile(p('report_files/chart.png'), encode('png'), { createParents: true });
      const pages = [];
      for await (const page of provider.enumerate(p(''))) pages.push(page);
      const entries = pages.flatMap((page) => page.entries);
      expect(entries.map((entry) => entry.path).sort()).to.deep.equal([
        'notes',
        'notes/a.md',
        'notes/deep',
        'notes/deep/b.md',
        // A companion folder is listed, not entered; a tool folder not at all.
        'report_files',
      ]);
      expect(entries.every((entry) => entry.version.startsWith('meta:'))).to.equal(true);
      expect(entries.find((entry) => entry.path === 'notes/a.md')).to.include({
        kind: 'file',
        size: 3,
      });
      expect(pages.flatMap((page) => page.unreadable)).to.deep.equal([]);
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

  it('walks folders in pages over a native that lists one folder at a time', async () => {
    const folders = new Map<string, Array<{ name: string; kind: 'file' | 'directory' }>>([
      [
        '',
        [
          { name: 'big', kind: 'directory' },
          { name: 'locked', kind: 'directory' },
          { name: '.git', kind: 'directory' },
        ],
      ],
      [
        'big',
        Array.from({ length: 2_500 }, (_, n) => ({ name: `n${n}.md`, kind: 'file' as const })),
      ],
    ]);
    const listed: string[] = [];
    const bridge = createMobileFileSystemBridge(async (request) => {
      if (request.op === 'open') return { ok: true, value: { ...capabilities } };
      if (request.op === 'dispose') return { ok: true, value: null };
      if (request.op !== 'listMetadata') throw new Error(`unexpected ${request.op}`);
      listed.push(request.path);
      if (request.path === 'locked') {
        return {
          ok: false,
          error: {
            name: 'FsError',
            code: 'permission-denied',
            message: 'No.',
            operation: 'list',
            path: 'locked',
            destinationPath: null,
            retryable: false,
          },
        };
      }
      const children = folders.get(request.path) ?? [];
      return {
        ok: true,
        value: children.map(({ name, kind }) => ({
          path: request.path ? `${request.path}/${name}` : name,
          name,
          kind,
          size: kind === 'file' ? 1 : null,
          version: `meta:${name}`,
          lastModified: '2026-11-20T00:00:00.000Z',
        })),
      };
    }, capabilities);
    const provider = new HostFileSystemProviderV2('local', 'Walk', 'Walk', {
      capabilities,
      limits: MOBILE_STORAGE_LIMITS,
      transport: bridge,
    });
    const pages = [];
    for await (const page of provider.enumerate(parseWorkspacePath(''))) pages.push(page);
    expect(pages.length).to.be.greaterThan(1);
    expect(pages.flatMap((page) => page.entries)).to.have.length(2 + 2_500);
    expect(pages.flatMap((page) => page.unreadable)).to.deep.equal(['locked']);
    // A tool folder is neither listed nor entered.
    expect(listed).to.deep.equal(['', 'big', 'locked']);
  });

  it('stages exports past the workspace file limit, up to its own', () => {
    // A minute of rendered video is already larger than a workspace file.
    const video = 24.6 * 1024 * 1024;
    expect(video).to.be.greaterThan(MOBILE_STORAGE_LIMITS.fileBytes);
    const begin = (byteLength: number) =>
      parseMobileExportRequest({
        op: 'begin',
        filename: 'deck.mp4',
        byteLength: Math.round(byteLength),
      });
    expect(begin(video).op).to.equal('begin');
    expect(begin(MOBILE_STORAGE_LIMITS.exportBytes).op).to.equal('begin');
    expect(() => begin(MOBILE_STORAGE_LIMITS.exportBytes + 1)).to.throw();
    expect(
      parseMobileExportRequest({
        op: 'append',
        transferId: 'transfer',
        offset: Math.round(video),
        data: '',
      }).op,
    ).to.equal('append');
  });
});
