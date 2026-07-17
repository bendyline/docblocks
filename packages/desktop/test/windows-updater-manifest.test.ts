import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import yaml from 'js-yaml';

import { prepareWindowsUpdaterManifest } from '../scripts/prepare-windows-updater-manifest.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

interface Fixture {
  readonly manifestPath: string;
  readonly universalName: string;
  readonly universalSha512: string;
}

const temporaryDirectories: string[] = [];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha512(value: Buffer): string {
  return createHash('sha512').update(value).digest('base64');
}

async function createFixture(options?: {
  readonly omitUniversal?: boolean;
  readonly invalidSha?: boolean;
}): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'docblocks-windows-updater-'));
  temporaryDirectories.push(directory);
  const universalName = 'DocBlocks-2.1.3-win.exe';
  const universal = Buffer.from('combined x64 and arm64 installer');
  const blockMap = Buffer.from('combined blockmap');
  await writeFile(path.join(directory, universalName), universal);
  await writeFile(path.join(directory, universalName + '.blockmap'), blockMap);

  const universalSha512 = sha512(universal);
  const files: UnknownRecord[] = [
    {
      url: 'DocBlocks-2.1.3-win-arm64.exe',
      sha512: sha512(Buffer.from('arm64')),
      size: 5,
      blockMapSize: 5,
    },
    {
      url: 'DocBlocks-2.1.3-win-x64.exe',
      sha512: sha512(Buffer.from('x64')),
      size: 3,
      blockMapSize: 3,
    },
  ];
  if (!options?.omitUniversal) {
    files.push({
      url: universalName,
      sha512: options?.invalidSha ? sha512(Buffer.from('wrong')) : universalSha512,
      size: universal.length,
      blockMapSize: blockMap.length,
    });
  }

  const manifestPath = path.join(directory, 'latest.yml');
  await writeFile(
    manifestPath,
    yaml.dump({
      version: '2.1.3',
      files,
      path: 'DocBlocks-2.1.3-win-arm64.exe',
      sha512: files[0]?.sha512,
      releaseDate: '2026-07-17T00:00:00.000Z',
    }),
    'utf8',
  );
  return { manifestPath, universalName, universalSha512 };
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
  it('selects only the combined installer and keeps manual architecture assets out of metadata', async () => {
    const fixture = await createFixture();

    const selected = await prepareWindowsUpdaterManifest(fixture.manifestPath);
    const parsed: unknown = yaml.load(await readFile(fixture.manifestPath, 'utf8'));

    expect(selected).to.equal(fixture.universalName);
    expect(isRecord(parsed)).to.equal(true);
    if (!isRecord(parsed)) throw new Error('Expected normalized updater manifest object.');
    expect(parsed.files).to.deep.equal([
      {
        url: fixture.universalName,
        sha512: fixture.universalSha512,
        size: Buffer.byteLength('combined x64 and arm64 installer'),
        blockMapSize: Buffer.byteLength('combined blockmap'),
      },
    ]);
    expect(parsed.path).to.equal(fixture.universalName);
    expect(parsed.sha512).to.equal(fixture.universalSha512);
    expect(parsed.version).to.equal('2.1.3');
  });

  it('fails when electron-builder does not produce one combined installer', async () => {
    const fixture = await createFixture({ omitUniversal: true });
    await expectFailure(
      prepareWindowsUpdaterManifest(fixture.manifestPath),
      'exactly one combined *-win.exe installer',
    );
  });

  it('fails before publishing metadata whose combined-installer hash is stale', async () => {
    const fixture = await createFixture({ invalidSha: true });
    await expectFailure(
      prepareWindowsUpdaterManifest(fixture.manifestPath),
      'SHA-512 does not match',
    );
  });
});
