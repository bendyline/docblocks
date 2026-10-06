import { expect } from 'chai';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { vcRuntimePath } from '../main/vc-runtime-path.js';

const require = createRequire(import.meta.url);
const { stageVcRuntime, findCrtFolder } = require('../scripts/stage-vc-runtime.cjs');

describe('Visual C++ runtime staging', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-vc-runtime-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function vsRedist(version: string, arch: string, dlls: readonly string[]) {
    const crt = path.join(root, 'vs', 'VC', 'Redist', 'MSVC', version, arch, 'Microsoft.VC143.CRT');
    await mkdir(crt, { recursive: true });
    for (const dll of dlls) await writeFile(path.join(crt, dll), `${version} ${dll}`);
    return crt;
  }

  it('picks the newest toolset that has a complete runtime for the target arch', async () => {
    await vsRedist('14.38.33130', 'x64', ['msvcp140.dll', 'vcruntime140.dll']);
    const newest = await vsRedist('14.40.33807', 'x64', [
      'msvcp140.dll',
      'vcruntime140.dll',
      'vcruntime140_1.dll',
    ]);
    // A newer toolset without the arch must not shadow an older complete one.
    await vsRedist('14.41.00000', 'arm64', ['msvcp140.dll', 'vcruntime140.dll']);
    expect(await findCrtFolder([path.join(root, 'vs')], 'x64')).to.equal(newest);
    expect(await findCrtFolder([path.join(root, 'missing')], 'x64')).to.equal(null);
  });

  it('copies required and present optional DLLs after verifying each one', async () => {
    await vsRedist('14.40.33807', 'arm64', ['msvcp140.dll', 'vcruntime140.dll']);
    const destination = path.join(root, 'out', 'arm64');
    const verified: string[] = [];
    const files = await stageVcRuntime({
      arch: 'arm64',
      destination,
      env: {},
      vsRoots: [path.join(root, 'vs')],
      verify: (file: string) => verified.push(path.basename(file)),
    });
    expect(files).to.deep.equal(['msvcp140.dll', 'vcruntime140.dll']);
    expect(verified).to.deep.equal(files);
    expect((await readdir(destination)).sort()).to.deep.equal(files);
  });

  it('refuses a DLL that fails signature verification', async () => {
    await vsRedist('14.40.33807', 'x64', ['msvcp140.dll', 'vcruntime140.dll']);
    let error: unknown;
    try {
      await stageVcRuntime({
        arch: 'x64',
        destination: path.join(root, 'out'),
        env: {},
        vsRoots: [path.join(root, 'vs')],
        verify: () => {
          throw new Error('unsigned');
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.equal('unsigned');
  });

  it('warns and leaves an empty folder when absent, unless the build requires it', async () => {
    const destination = path.join(root, 'out', 'x64');
    const warnings: string[] = [];
    const files = await stageVcRuntime({
      arch: 'x64',
      destination,
      env: {},
      vsRoots: [],
      warn: (message: string) => warnings.push(message),
    });
    expect(files).to.deep.equal([]);
    expect(await readdir(destination)).to.deep.equal([]);
    expect(warnings[0]).to.contain('win32/x64 not found');

    let error: unknown;
    try {
      await stageVcRuntime({
        arch: 'x64',
        destination,
        env: { DOCBLOCKS_VCRUNTIME_REQUIRED: '1' },
        vsRoots: [],
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.contain('not found');
  });

  it('honours an explicit CRT folder', async () => {
    const crt = await vsRedist('14.40.33807', 'x64', ['msvcp140.dll', 'vcruntime140.dll']);
    const files = await stageVcRuntime({
      arch: 'x64',
      destination: path.join(root, 'out'),
      env: { DOCBLOCKS_VCRUNTIME_DIR: crt },
      vsRoots: [],
      verify: () => undefined,
    });
    expect(files).to.deep.equal(['msvcp140.dll', 'vcruntime140.dll']);
  });
});

describe('vcRuntimePath', () => {
  it('appends the packaged runtime folder on Windows only', () => {
    expect(vcRuntimePath(true, 'C:\\App\\resources', 'C:\\Windows;C:\\Tools', 'win32')).to.equal(
      'C:\\Windows;C:\\Tools;C:\\App\\resources\\vc-runtime',
    );
    expect(vcRuntimePath(true, 'C:\\App\\resources', undefined, 'win32')).to.equal(
      'C:\\App\\resources\\vc-runtime',
    );
    expect(vcRuntimePath(false, 'C:\\App\\resources', 'C:\\Windows', 'win32')).to.equal(null);
    expect(vcRuntimePath(true, '/Applications/DocBlocks.app', '/usr/bin', 'darwin')).to.equal(null);
  });

  it('does not add the folder twice', () => {
    expect(
      vcRuntimePath(
        true,
        'C:\\App\\resources',
        'C:\\app\\RESOURCES\\vc-runtime;C:\\Windows',
        'win32',
      ),
    ).to.equal(null);
  });
});
