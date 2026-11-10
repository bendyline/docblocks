import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import yaml from 'js-yaml';

import { prepareWindowsUpdaterManifest } from '../scripts/prepare-windows-updater-manifest.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

const INSTALLERS = {
  arm64: { name: 'DocBlocks-2.1.3-win-arm64.exe', bytes: Buffer.from('arm64 installer') },
  x64: { name: 'DocBlocks-2.1.3-win-x64.exe', bytes: Buffer.from('x64 installer') },
  combined: {
    name: 'DocBlocks-2.1.3-win.exe',
    bytes: Buffer.from('combined x64 and arm64 installer'),
  },
} as const;

type InstallerKey = keyof typeof INSTALLERS;

interface FixtureOptions {
  readonly unlisted?: InstallerKey;
  readonly invalidSha?: InstallerKey;
  readonly omitBlockMap?: InstallerKey;
  readonly emptyBlockMap?: InstallerKey;
  readonly blockMapSize?: number;
}

interface Fixture {
  readonly directory: string;
  readonly manifestPath: string;
}

const temporaryDirectories: string[] = [];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha512(value: Buffer): string {
  return createHash('sha512').update(value).digest('base64');
}

function entryFor(key: InstallerKey): UnknownRecord {
  const installer = INSTALLERS[key];
  return { url: installer.name, sha512: sha512(installer.bytes), size: installer.bytes.length };
}

/** The artifacts folder as electron-builder leaves it: three installers listed in one latest.yml. */
async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'docblocks-windows-updater-'));
  temporaryDirectories.push(directory);

  const files: UnknownRecord[] = [];
  for (const key of Object.keys(INSTALLERS) as InstallerKey[]) {
    const installer = INSTALLERS[key];
    await writeFile(path.join(directory, installer.name), installer.bytes);
    if (options.omitBlockMap !== key) {
      await writeFile(
        path.join(directory, installer.name + '.blockmap'),
        options.emptyBlockMap === key ? Buffer.alloc(0) : Buffer.from(key + ' blockmap'),
      );
    }
    if (options.unlisted === key) continue;
    files.push({
      ...entryFor(key),
      ...(options.invalidSha === key ? { sha512: sha512(Buffer.from('wrong')) } : {}),
      ...(key === 'combined' && options.blockMapSize !== undefined
        ? { blockMapSize: options.blockMapSize }
        : {}),
    });
  }

  const manifestPath = path.join(directory, 'latest.yml');
  await writeFile(
    manifestPath,
    yaml.dump({
      version: '2.1.3',
      files,
      path: files[0]?.url,
      sha512: files[0]?.sha512,
      releaseDate: '2026-07-17T00:00:00.000Z',
    }),
    'utf8',
  );
  return { directory, manifestPath };
}

async function readManifest(directory: string, name: string): Promise<UnknownRecord> {
  const parsed: unknown = yaml.load(await readFile(path.join(directory, name), 'utf8'));
  if (!isRecord(parsed)) throw new Error('Expected ' + name + ' to hold an updater manifest.');
  return parsed;
}

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(Error);
  expect((failure as Error).message).to.include(message);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Windows updater manifest preparation', () => {
  it('names only the combined installer in latest.yml, for clients that read nothing else', async () => {
    const fixture = await createFixture();

    await prepareWindowsUpdaterManifest(fixture.manifestPath);
    const manifest = await readManifest(fixture.directory, 'latest.yml');

    expect(manifest.files).to.deep.equal([entryFor('combined')]);
    expect(manifest.path).to.equal(INSTALLERS.combined.name);
    expect(manifest.sha512).to.equal(sha512(INSTALLERS.combined.bytes));
    expect(manifest.version).to.equal('2.1.3');
  });

  it('writes one manifest per architecture, each naming only that installer', async () => {
    const fixture = await createFixture();

    const feeds = await prepareWindowsUpdaterManifest(fixture.manifestPath);

    expect(feeds).to.deep.equal([
      { manifest: 'latest-win-x64.yml', installer: INSTALLERS.x64.name },
      { manifest: 'latest-win-arm64.yml', installer: INSTALLERS.arm64.name },
      { manifest: 'latest.yml', installer: INSTALLERS.combined.name },
    ]);
    for (const key of ['x64', 'arm64'] as const) {
      const manifest = await readManifest(fixture.directory, 'latest-win-' + key + '.yml');
      expect(manifest.files).to.deep.equal([entryFor(key)]);
      expect(manifest.path).to.equal(INSTALLERS[key].name);
      expect(manifest.sha512).to.equal(sha512(INSTALLERS[key].bytes));
      expect(manifest.version).to.equal('2.1.3');
      expect(manifest.releaseDate).to.equal('2026-07-17T00:00:00.000Z');
    }
  });

  it('fails when electron-builder does not produce one combined installer', async () => {
    const fixture = await createFixture({ unlisted: 'combined' });
    await expectFailure(
      prepareWindowsUpdaterManifest(fixture.manifestPath),
      'exactly one combined *-win.exe installer',
    );
  });

  it('fails when an architecture has no installer to name', async () => {
    const fixture = await createFixture({ unlisted: 'arm64' });
    await expectFailure(
      prepareWindowsUpdaterManifest(fixture.manifestPath),
      'exactly one *-win-arm64.exe installer',
    );
  });

  it('fails when the combined installer blockmap is missing', async () => {
    const fixture = await createFixture({ omitBlockMap: 'combined' });
    await expectFailure(prepareWindowsUpdaterManifest(fixture.manifestPath), 'blockmap is missing');
  });

  it('fails when an architecture installer blockmap is missing', async () => {
    const fixture = await createFixture({ omitBlockMap: 'x64' });
    await expectFailure(
      prepareWindowsUpdaterManifest(fixture.manifestPath),
      INSTALLERS.x64.name + ' blockmap is missing',
    );
  });

  it('fails when the combined installer blockmap is empty', async () => {
    const fixture = await createFixture({ emptyBlockMap: 'combined' });
    await expectFailure(
      prepareWindowsUpdaterManifest(fixture.manifestPath),
      'blockmap must be a non-empty file',
    );
  });

  it('validates blockmap size when electron-builder includes it', async () => {
    const fixture = await createFixture({ blockMapSize: 1 });
    await expectFailure(
      prepareWindowsUpdaterManifest(fixture.manifestPath),
      'blockmap size mismatch',
    );
  });

  it('fails before publishing metadata whose combined-installer hash is stale', async () => {
    const fixture = await createFixture({ invalidSha: 'combined' });
    await expectFailure(
      prepareWindowsUpdaterManifest(fixture.manifestPath),
      INSTALLERS.combined.name + ' SHA-512 does not match',
    );
  });

  it('writes nothing when any installer fails verification', async () => {
    const fixture = await createFixture({ invalidSha: 'combined' });
    const original = await readFile(fixture.manifestPath, 'utf8');

    await expectFailure(
      prepareWindowsUpdaterManifest(fixture.manifestPath),
      'SHA-512 does not match',
    );

    expect(await readFile(fixture.manifestPath, 'utf8')).to.equal(original);
    expect(existsSync(path.join(fixture.directory, 'latest-win-x64.yml'))).to.equal(false);
    expect(existsSync(path.join(fixture.directory, 'latest-win-arm64.yml'))).to.equal(false);
  });
});
