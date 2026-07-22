import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect } from 'chai';

interface HookContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
}

interface ElectronLicenseHookModule {
  readonly default: (context: HookContext) => Promise<void>;
}

const require = createRequire(import.meta.url);
const copyElectronLicenses = (
  require('../scripts/copy-electron-licenses.cjs') as ElectronLicenseHookModule
).default;

describe('copy Electron licenses after extraction', () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-electron-licenses-'));
  });

  afterEach(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function writeExtractedLegalFiles(electronLicenseName: string): Promise<void> {
    await fs.writeFile(path.join(temporaryDirectory, electronLicenseName), 'electron license');
    await fs.writeFile(path.join(temporaryDirectory, 'LICENSES.chromium.html'), 'chromium notices');
  }

  async function expectCopiedLegalFiles(resourcesDirectory: string): Promise<void> {
    expect(
      await fs.readFile(path.join(resourcesDirectory, 'licenses', 'ELECTRON_LICENSE.txt'), 'utf8'),
    ).to.equal('electron license');
    expect(
      await fs.readFile(
        path.join(resourcesDirectory, 'licenses', 'ELECTRON_THIRD_PARTY_NOTICES.html'),
        'utf8',
      ),
    ).to.equal('chromium notices');
  }

  it('copies renamed legal files into Windows and Linux resources', async () => {
    const resourcesDirectory = path.join(temporaryDirectory, 'resources');
    await fs.mkdir(resourcesDirectory);
    await writeExtractedLegalFiles('LICENSE.electron.txt');

    await copyElectronLicenses({
      appOutDir: temporaryDirectory,
      electronPlatformName: 'win32',
    });

    await expectCopiedLegalFiles(resourcesDirectory);
  });

  it('copies legal files into the extracted macOS app bundle', async () => {
    const resourcesDirectory = path.join(
      temporaryDirectory,
      'Electron.app',
      'Contents',
      'Resources',
    );
    await fs.mkdir(resourcesDirectory, { recursive: true });
    await writeExtractedLegalFiles('LICENSE');

    await copyElectronLicenses({
      appOutDir: temporaryDirectory,
      electronPlatformName: 'darwin',
    });

    await expectCopiedLegalFiles(resourcesDirectory);
  });

  it('fails packaging when the extracted archive omits legal files', async () => {
    await fs.mkdir(path.join(temporaryDirectory, 'resources'));
    let thrown: unknown;

    try {
      await copyElectronLicenses({
        appOutDir: temporaryDirectory,
        electronPlatformName: 'linux',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as Error).message).to.contain(
      'Electron legal resource is missing from the extracted archive',
    );
  });
});
