import { expect } from 'chai';
import {
  FsError,
  WORKSPACE_ROOT,
  isSerializedFsError,
  parseWorkspacePath,
  type FileSystemProviderV2,
  type FileSystemSnapshot,
  type FileSystemWatchEvent,
  type WorkspacePath,
} from '../../src/filesystem/index.js';

export type FileSystemProviderV2Factory =
  | (() => FileSystemProviderV2)
  | (() => Promise<FileSystemProviderV2>);

/**
 * Shared behavioral contract for every v2 provider implementation.
 * A backend joins the matrix by supplying a fresh, empty provider factory.
 */
export function defineFileSystemProviderV2Conformance(
  name: string,
  factory: FileSystemProviderV2Factory,
): void {
  describe(`${name} FileSystemProviderV2 conformance`, () => {
    let provider: FileSystemProviderV2;

    beforeEach(async () => {
      provider = await factory();
    });

    afterEach(async () => {
      await provider.dispose();
    });

    it('round-trips one owned byte payload and returns defensive copies', async () => {
      const backing = new Uint8Array([0, 1, 2, 3]).buffer;
      const visible = new Uint8Array(backing, 1, 2);
      const path = p('/docs/note.md');
      const written = await provider.writeFile(path, visible, {
        mode: 'create',
        createParents: true,
      });
      visible[0] = 9;

      const first = await provider.readFile(path);
      expect(first?.entry.version).to.equal(written.version);
      expect(bytes(first?.data)).to.deep.equal([1, 2]);
      new Uint8Array(first!.data)[0] = 8;
      expect(bytes((await provider.readFile(path))?.data)).to.deep.equal([1, 2]);

      const snapshot = await provider.snapshot();
      const file = snapshot.entries.find((entry) => entry.path === path);
      expect(file?.kind).to.equal('file');
      if (file?.kind === 'file') new Uint8Array(file.data)[1] = 7;
      expect(bytes((await provider.readFile(path))?.data)).to.deep.equal([1, 2]);
    });

    it('enforces create/replace modes and exact conditional versions', async () => {
      const path = p('/note.md');
      const first = await provider.writeFile(path, encoded('one'), { mode: 'create' });

      await expectFsError(
        provider.writeFile(path, encoded('duplicate'), { mode: 'create' }),
        'already-exists',
      );
      await expectFsError(
        provider.writeFile(p('/missing.md'), encoded('missing'), { mode: 'replace' }),
        'not-found',
      );

      const second = await provider.writeFile(path, encoded('two'), {
        mode: 'replace',
        expectedVersion: first.version,
      });
      expect(second.version).not.to.equal(first.version);
      const treeBeforeRejectedWrite = (await provider.snapshot()).version;
      await expectFsError(
        provider.writeFile(path, encoded('stale'), {
          mode: 'replace',
          expectedVersion: first.version,
        }),
        'conflict',
      );
      expect((await provider.snapshot()).version).to.equal(treeBeforeRejectedWrite);
      await expectFsError(
        provider.writeFile(path, encoded('must be absent'), { expectedVersion: null }),
        'conflict',
      );
      expect(decoded((await provider.readFile(path))?.data)).to.equal('two');
    });

    it('allows only one concurrent conditional write to claim the same version', async () => {
      const path = p('/contended.md');
      const baseline = await provider.writeFile(path, encoded('baseline'));
      const results = await Promise.allSettled([
        provider.writeFile(path, encoded('first'), { expectedVersion: baseline.version }),
        provider.writeFile(path, encoded('second'), { expectedVersion: baseline.version }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).to.have.length(1);
      const rejection = results.find((result) => result.status === 'rejected');
      expect(rejection?.status).to.equal('rejected');
      if (rejection?.status === 'rejected') {
        expect(isFsErrorLike(rejection.reason)).to.equal(true);
        expect((rejection.reason as FsError).code).to.equal('conflict');
      }
      expect(['first', 'second']).to.include(decoded((await provider.readFile(path))?.data));
    });

    it('maintains one entry kind per path and rejects file parents', async () => {
      const directory = p('/folder');
      await provider.createDirectory(directory, { mode: 'create' });
      await expectFsError(provider.writeFile(directory, encoded('file')), 'type-mismatch');

      const file = p('/node');
      await provider.writeFile(file, encoded('file'), { mode: 'create' });
      await expectFsError(provider.createDirectory(file, { mode: 'ensure' }), 'type-mismatch');
      await expectFsError(
        provider.writeFile(p('/node/child.md'), encoded('child'), { createParents: true }),
        'type-mismatch',
      );
      expect((await provider.stat(file))?.kind).to.equal('file');
    });

    it('requires explicit parent creation and leaves no partial parents on rejection', async () => {
      const file = p('/missing/deep/note.md');
      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.writeFile(file, encoded('content')),
        'not-found',
      );
      expect(await provider.stat(p('/missing'))).to.equal(null);
      expect(await provider.stat(p('/missing/deep'))).to.equal(null);
      expect(await provider.stat(file)).to.equal(null);

      const replaceOnly = p('/replace-only/deep/note.md');
      await expectRejectedMutationWithoutChange(
        provider,
        () =>
          provider.writeFile(replaceOnly, encoded('content'), {
            mode: 'replace',
            createParents: true,
          }),
        'not-found',
      );
      expect(await provider.stat(p('/replace-only'))).to.equal(null);
      expect(await provider.stat(p('/replace-only/deep'))).to.equal(null);
      expect(await provider.stat(replaceOnly)).to.equal(null);

      const directory = p('/directories/deep/leaf');
      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.createDirectory(directory),
        'not-found',
      );
      expect(await provider.stat(p('/directories'))).to.equal(null);
      expect(await provider.stat(p('/directories/deep'))).to.equal(null);
      expect(await provider.stat(directory)).to.equal(null);

      const source = p('/source.md');
      const destination = p('/archive/deep/source.md');
      await provider.writeFile(source, encoded('source'));
      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.move(source, destination),
        'not-found',
      );
      expect(decoded((await provider.readFile(source))?.data)).to.equal('source');
      expect(await provider.stat(p('/archive'))).to.equal(null);
      expect(await provider.stat(destination)).to.equal(null);

      await provider.writeFile(file, encoded('content'), { createParents: true });
      await provider.createDirectory(directory, { createParents: true });
      await provider.move(source, destination, { createParents: true });
      expect((await provider.stat(p('/missing/deep')))?.kind).to.equal('directory');
      expect((await provider.stat(directory))?.kind).to.equal('directory');
      expect(decoded((await provider.readFile(destination))?.data)).to.equal('source');
    });

    it('keeps the workspace root directory-only', async () => {
      expect((await provider.stat(WORKSPACE_ROOT))?.kind).to.equal('directory');
      await expectFsError(provider.writeFile(WORKSPACE_ROOT, encoded('root file')), 'invalid-path');
      await expectFsError(provider.remove(WORKSPACE_ROOT, { recursive: true }), 'invalid-path');
      expect((await provider.createDirectory(WORKSPACE_ROOT))?.kind).to.equal('directory');
    });

    it('requires explicit recursive deletion and has explicit missing semantics', async () => {
      const directory = p('/tree');
      const child = p('/tree/deep/file.md');
      await provider.writeFile(child, encoded('content'), { createParents: true });

      await expectFsError(provider.remove(directory), 'not-empty');
      expect(await provider.stat(child)).not.to.equal(null);

      const removed = await provider.remove(directory, { recursive: true });
      expect(removed.removed).to.equal(true);
      expect(await provider.stat(directory)).to.equal(null);
      expect(await provider.stat(child)).to.equal(null);

      await expectFsError(provider.remove(directory), 'not-found');
      expect((await provider.remove(directory, { missing: 'ignore' })).removed).to.equal(false);
    });

    it('removes an empty directory without requiring recursive mode', async () => {
      const directory = p('/empty');
      const created = await provider.createDirectory(directory, { mode: 'create' });

      const removed = await provider.remove(directory, {
        expectedVersion: created.version,
      });
      expect(removed.removed).to.equal(true);
      expect(await provider.stat(directory)).to.equal(null);
    });

    it('guards remove and move with the exact current source version', async () => {
      const source = p('/versioned.md');
      const first = await provider.writeFile(source, encoded('first'), { mode: 'create' });
      const current = await provider.writeFile(source, encoded('current'), {
        mode: 'replace',
        expectedVersion: first.version,
      });

      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.remove(source, { expectedVersion: first.version }),
        'conflict',
      );
      expect((await provider.stat(source))?.version).to.equal(current.version);
      expect(decoded((await provider.readFile(source))?.data)).to.equal('current');

      const destination = p('/stale-move/deep/moved.md');
      await expectRejectedMutationWithoutChange(
        provider,
        () =>
          provider.move(source, destination, {
            createParents: true,
            expectedVersion: first.version,
          }),
        'conflict',
      );
      expect((await provider.stat(source))?.version).to.equal(current.version);
      expect(await provider.stat(p('/stale-move'))).to.equal(null);
      expect(await provider.stat(p('/stale-move/deep'))).to.equal(null);
      expect(await provider.stat(destination)).to.equal(null);
      expect(decoded((await provider.readFile(source))?.data)).to.equal('current');
    });

    it('moves complete subtrees without overwrite and preserves state on rejection', async () => {
      const source = p('/source');
      const sourceFile = p('/source/deep/file.md');
      const destination = p('/archive/source');
      await provider.writeFile(sourceFile, encoded('source'), { createParents: true });
      await provider.move(source, destination, { createParents: true });

      expect(await provider.stat(source)).to.equal(null);
      expect(decoded((await provider.readFile(p('/archive/source/deep/file.md')))?.data)).to.equal(
        'source',
      );

      const left = p('/left.md');
      const right = p('/right.md');
      await provider.writeFile(left, encoded('left'));
      await provider.writeFile(right, encoded('right'));
      await expectFsError(provider.move(left, right), 'already-exists');
      expect(decoded((await provider.readFile(left))?.data)).to.equal('left');
      expect(decoded((await provider.readFile(right))?.data)).to.equal('right');

      await expectFsError(provider.move(destination, p('/archive/source/inside')), 'invalid-path');
      expect(await provider.stat(destination)).not.to.equal(null);
    });

    it('returns canonical, deterministic, directory-first listings', async () => {
      await provider.writeFile(p('/z.md'), encoded('z'));
      await provider.writeFile(p('/b.md'), encoded('b'));
      await provider.createDirectory(p('/a'));

      const listing = await provider.readDirectory(WORKSPACE_ROOT);
      expect(listing.map((entry) => `${entry.kind}:${entry.path}`)).to.deep.equal([
        'directory:a',
        'file:b.md',
        'file:z.md',
      ]);
    });

    it('revalidates forged paths and only exposes canonical paths', async () => {
      const forgedCanonical = '\\docs\\nested///note.md/' as WorkspacePath;
      const canonical = p('/docs/nested/note.md');
      const written = await provider.writeFile(forgedCanonical, encoded('content'), {
        createParents: true,
      });
      expect(written.path).to.equal(canonical);
      expect(decoded((await provider.readFile(canonical))?.data)).to.equal('content');

      const forgedEscape = '../outside.md' as WorkspacePath;
      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.writeFile(forgedEscape, encoded('outside'), { createParents: true }),
        'path-escape',
      );

      const snapshot = await provider.snapshot();
      expect(snapshot.entries.map((entry) => entry.path)).to.deep.equal([
        WORKSPACE_ROOT,
        p('/docs'),
        p('/docs/nested'),
        canonical,
      ]);
    });

    it('returns deterministic complete snapshots with one canonical root', async () => {
      await provider.writeFile(p('/z.md'), encoded('z'));
      await provider.writeFile(p('/a/deep.md'), encoded('deep'), { createParents: true });
      await provider.createDirectory(p('/empty'));

      const first = await provider.snapshot();
      const second = await provider.snapshot();
      expect(snapshotView(second)).to.deep.equal(snapshotView(first));

      const roots = first.entries.filter((entry) => entry.path === WORKSPACE_ROOT);
      expect(roots).to.have.length(1);
      expect(roots[0]).to.include({
        kind: 'directory',
        name: '',
        path: WORKSPACE_ROOT,
        size: null,
        version: first.version,
      });

      const paths = first.entries.map((entry) => entry.path);
      expect(paths).to.deep.equal([...paths].sort((left, right) => left.localeCompare(right)));
      expect(new Set(paths).size).to.equal(paths.length);
      for (const entry of first.entries) {
        expect(parseWorkspacePath(String(entry.path))).to.equal(entry.path);
        if (entry.kind === 'file') {
          expect(entry.data.byteLength).to.equal(entry.size);
        }
      }
    });

    it('leaves the complete observable state unchanged after rejected mutations', async () => {
      const file = p('/node.md');
      const directory = p('/directory');
      const child = p('/directory/child.md');
      const destination = p('/destination.md');
      await provider.writeFile(file, encoded('node'));
      await provider.writeFile(child, encoded('child'), { createParents: true });
      await provider.writeFile(destination, encoded('destination'));

      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.writeFile(file, encoded('duplicate'), { mode: 'create' }),
        'already-exists',
      );
      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.writeFile(p('/node.md/child.md'), encoded('child'), { createParents: true }),
        'type-mismatch',
      );
      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.remove(directory),
        'not-empty',
      );
      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.move(file, destination),
        'already-exists',
      );
      await expectRejectedMutationWithoutChange(
        provider,
        () => provider.createDirectory(file),
        'type-mismatch',
      );
    });

    it('publishes ordered watch events after readiness and supports awaitable disposal', async () => {
      if (!provider.capabilities.watch) {
        const errors: FsError[] = [];
        const subscription = provider.watch(() => undefined, {
          onError: (error) => errors.push(error),
        });
        await expectFsError(subscription.ready, 'not-supported');
        expect(errors.map((error) => error.code)).to.deep.equal(['not-supported']);
        await subscription.dispose();
        await subscription.dispose();
        expect(subscription.closed).to.equal(true);
        return;
      }

      const events: FileSystemWatchEvent[] = [];
      const errors: FsError[] = [];
      const subscription = provider.watch((event) => events.push(event), {
        onError: (error) => errors.push(error),
      });
      await subscription.ready;

      const first = p('/first.md');
      const second = p('/second.md');
      await provider.writeFile(first, encoded('one'));
      await provider.writeFile(first, encoded('two'));
      await provider.move(first, second);
      await provider.remove(second);

      expect(events.map((event) => event.type)).to.deep.equal([
        'created',
        'modified',
        'moved',
        'removed',
      ]);
      expect(events.map((event) => event.sequence)).to.deep.equal([1, 2, 3, 4]);
      expect(events.every((event) => event.origin === 'local')).to.equal(true);
      expect(errors).to.deep.equal([]);

      const firstDispose = subscription.dispose();
      const secondDispose = subscription.dispose();
      await Promise.all([firstDispose, secondDispose]);
      expect(subscription.closed).to.equal(true);
      await provider.writeFile(p('/after-unsubscribe.md'), encoded('ignored'));
      expect(events).to.have.length(4);
    });

    it('disposes idempotently, closes subscriptions, and rejects subsequent operations', async () => {
      const subscription = provider.capabilities.watch ? provider.watch(() => undefined) : null;
      await subscription?.ready;
      await provider.dispose();
      await provider.dispose();

      expect(subscription?.closed ?? true).to.equal(true);
      await expectFsError(provider.snapshot(), 'disposed');
      let watchFailure: unknown;
      try {
        provider.watch(() => undefined);
      } catch (error: unknown) {
        watchFailure = error;
      }
      expect(isFsErrorLike(watchFailure)).to.equal(true);
      expect((watchFailure as FsError).code).to.equal('disposed');
    });
  });
}

export async function expectFsError(
  promise: Promise<unknown>,
  code: FsError['code'],
): Promise<FsError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    thrown = error;
  }
  expect(isFsErrorLike(thrown)).to.equal(true);
  expect((thrown as FsError).code).to.equal(code);
  return thrown as FsError;
}

async function expectRejectedMutationWithoutChange(
  provider: FileSystemProviderV2,
  mutation: () => Promise<unknown>,
  code: FsError['code'],
): Promise<void> {
  const before = snapshotView(await provider.snapshot());
  await expectFsError(mutation(), code);
  expect(snapshotView(await provider.snapshot())).to.deep.equal(before);
}

function snapshotView(snapshot: FileSystemSnapshot) {
  return {
    version: snapshot.version,
    entries: snapshot.entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      size: entry.size,
      version: entry.version,
      lastModified: entry.lastModified,
      data: entry.kind === 'file' ? [...new Uint8Array(entry.data)] : null,
    })),
  };
}

function isFsErrorLike(value: unknown): value is FsError {
  return value instanceof FsError || isSerializedFsError(value);
}

function p(value: string) {
  return parseWorkspacePath(value);
}

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decoded(value: ArrayBuffer | undefined): string | null {
  return value ? new TextDecoder().decode(value) : null;
}

function bytes(value: ArrayBuffer | undefined): number[] | null {
  return value ? [...new Uint8Array(value)] : null;
}
