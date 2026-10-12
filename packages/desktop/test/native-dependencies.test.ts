import { expect } from 'chai';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const {
  selectNativePackages,
  stageNativeDependencies,
  verifyNativeDependencies,
} = require('../scripts/native-dependencies.cjs');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const lock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const families = [
  '@napi-rs/canvas',
  '@napi-rs/keyring',
  '@resvg/resvg-js',
  '@vscode/ripgrep',
  'sqlite-vec',
];

function binary(platform: string, arch: string): Buffer {
  const bytes = Buffer.alloc(256);
  if (platform === 'win32') {
    bytes.write('MZ');
    bytes.writeUInt32LE(128, 0x3c);
    bytes.write('PE\0\0', 128);
    bytes.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 132);
  } else if (platform === 'linux') {
    bytes.write('\x7fELF');
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf);
    bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4);
  }
  return bytes;
}

describe('target native dependencies in desktop packages', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-native-deps-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const arch of ['x64', 'arm64']) {
      it(`selects only locked ${platform}-${arch} variants independently of the host`, () => {
        const packages = selectNativePackages(lock, platform, arch);
        expect(packages).to.have.length(platform === 'win32' && arch === 'arm64' ? 4 : 5);
        for (const entry of packages) {
          expect(entry.cpu).to.include(arch);
          expect(entry.os).to.include(platform);
          expect(entry.name).not.to.contain('musl');
          expect(entry.integrity).to.match(/^sha512-/);
        }
      });
    }
  }

  it('fails closed when a required target variant disappears from the lockfile', () => {
    const changed = structuredClone(lock);
    delete changed.packages['node_modules/@napi-rs/keyring-win32-arm64-msvc'];
    expect(() => selectNativePackages(changed, 'win32', 'arm64')).to.throw(
      'Missing exact platform package',
    );
  });

  it('rejects unpinned downloads and variants that acquired an install script', () => {
    for (const patch of [{ integrity: '' }, { hasInstallScript: true }]) {
      const changed = structuredClone(lock);
      Object.assign(changed.packages['node_modules/@napi-rs/keyring-linux-arm64-gnu'], patch);
      expect(() => selectNativePackages(changed, 'linux', 'arm64')).to.throw();
    }
  });

  async function writeVariant(
    directory: string,
    entry: { name: string; version: string; os: string[]; cpu: string[] },
    platform: string,
    arch: string,
  ) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: entry.name,
        version: entry.version,
        os: entry.os,
        cpu: entry.cpu,
        main: 'binding.node',
      }),
    );
    await writeFile(path.join(directory, 'binding.node'), binary(platform, arch));
  }

  it('stages target packages with SRI and scripts disabled without changing host dependencies', async () => {
    const hostFile = path.join(root, 'node_modules', 'host-marker');
    await mkdir(path.dirname(hostFile), { recursive: true });
    await writeFile(hostFile, 'untouched');
    const packages = selectNativePackages(lock, 'win32', 'arm64');
    const calls: string[] = [];
    await stageNativeDependencies({
      appDir: root,
      platform: 'win32',
      arch: 'arm64',
      lock,
      extract: async (
        url: string,
        destination: string,
        options: { integrity: string; ignoreScripts: boolean },
      ) => {
        const entry = packages.find((item: { resolved: string }) => item.resolved === url);
        expect(options.integrity).to.equal(entry.integrity);
        expect(options.ignoreScripts).to.equal(true);
        expect(destination).to.equal(
          path.join(root, 'dist/native-modules/win-arm64/node_modules', entry.name),
        );
        calls.push(entry.name);
        await writeVariant(destination, entry, 'win32', 'arm64');
      },
    });
    expect(calls).to.deep.equal(packages.map((entry: { name: string }) => entry.name));
    expect(await readFile(hostFile, 'utf8')).to.equal('untouched');
  });

  it('rejects an x64 binary inside an ARM64-labelled staging package', async () => {
    const packages = selectNativePackages(lock, 'linux', 'arm64');
    let error: unknown;
    try {
      await stageNativeDependencies({
        appDir: root,
        platform: 'linux',
        arch: 'arm64',
        lock,
        extract: async (url: string, destination: string) => {
          await writeVariant(
            destination,
            packages.find((entry: { resolved: string }) => entry.resolved === url),
            'linux',
            'x64',
          );
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.contain('Wrong native architecture');
  });

  it('copies and unpacks the target fileset using the real electron-builder configuration', async () => {
    const config = yaml.load(
      await readFile(path.join(repoRoot, 'packages/desktop/electron-builder.yml'), 'utf8'),
    );
    const {
      getMainFileMatchers,
      getFileMatchers,
      getNodeModuleFileMatcher,
    } = require('app-builder-lib/out/fileMatcher');
    const { computeFileSets } = require('app-builder-lib/out/util/appFileCopier');
    const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil');
    const entry = selectNativePackages(lock, 'win32', 'arm64')[0];
    const staging = path.join(root, 'dist/native-modules/win-arm64/node_modules', entry.name);
    await writeVariant(staging, entry, 'win32', 'arm64');
    const resources = path.join(root, 'out/resources');
    const destination = path.join(resources, 'app');
    await mkdir(resources, { recursive: true });
    const info = {
      config,
      appDir: root,
      projectDir: root,
      buildResourcesDir: 'resources',
      debugLogger: { isEnabled: false },
      getWorkspaceRoot: async () => root,
    };
    const packager = { info };
    const expand = (value: string) =>
      value
        .replaceAll('${os}', 'win')
        .replaceAll('${platform}', 'win32')
        .replaceAll('${arch}', 'arm64');
    const matchers = getMainFileMatchers(
      root,
      destination,
      expand,
      {},
      packager,
      path.join(root, 'out'),
      false,
    );
    const fileSets = (await computeFileSets(matchers, null, packager, false)).filter(
      (set: { files: string[] }) => set.files.length,
    );
    const unpack = getFileMatchers(config, 'asarUnpack', destination, {
      defaultSrc: root,
      globalOutDir: path.join(root, 'out'),
      macroExpander: expand,
      customBuildOptions: {},
    })[0].createFilter();
    await new AsarPackager(packager, {
      resourcePath: resources,
      defaultDestination: destination,
      options: {},
      unpackPattern: unpack,
    }).pack(fileSets);
    const nativePath = path.join('node_modules', entry.name, 'binding.node');
    expect(asar.statFile(path.join(resources, 'app.asar'), nativePath).unpacked).to.equal(true);
    expect(await readFile(path.join(resources, 'app.asar.unpacked', nativePath))).to.deep.equal(
      binary('win32', 'arm64'),
    );
    const hostName = '@napi-rs/canvas-win32-x64-msvc';
    const dependencyFilter = getNodeModuleFileMatcher(
      root,
      destination,
      expand,
      {},
      info,
    ).createFilter();
    for (const prefix of ['node_modules', 'node_modules/parent/node_modules']) {
      const relative = `${prefix}/${hostName}/binding.node`;
      expect(
        dependencyFilter(path.join(root, relative), {
          isDirectory: () => false,
          moduleFullFilePath: relative,
        }),
      ).to.equal(false);
    }
  });

  async function makeArchive(
    platform: string,
    arch: string,
    options: {
      missing?: string;
      wrongArch?: boolean;
      packed?: boolean;
      foreign?: boolean;
      loaderDrift?: boolean;
    } = {},
  ) {
    const source = path.join(root, 'app');
    for (const family of families) {
      const directory = path.join(source, 'node_modules', family);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({
          name: family,
          version: options.loaderDrift ? '0.0.0' : lock.packages[`node_modules/${family}`].version,
        }),
      );
    }
    for (const entry of selectNativePackages(lock, platform, arch)) {
      if (entry.name === options.missing) continue;
      await writeVariant(
        path.join(source, 'node_modules', entry.name),
        entry,
        platform,
        options.wrongArch ? 'x64' : arch,
      );
    }
    if (options.foreign) {
      const entry = selectNativePackages(lock, platform, 'x64')[0];
      await writeVariant(path.join(source, 'node_modules', entry.name), entry, platform, 'x64');
    }
    const asarPath = path.join(root, 'app.asar');
    await asar.createPackageWithOptions(
      source.replaceAll('\\', '/'),
      asarPath,
      options.packed ? {} : { unpack: '**/*.node' },
    );
    return { asarPath, platform, arch, lock };
  }

  for (const platform of ['win32', 'linux', 'darwin']) {
    it(`accepts a complete ${platform}-arm64 ASAR and verifies its unpacked bytes`, async () => {
      const result = await verifyNativeDependencies(await makeArchive(platform, 'arm64'));
      expect(result.binariesChecked).to.equal(platform === 'win32' ? 4 : 5);
    });
  }

  for (const [label, options, expected] of [
    [
      'missing binding',
      { missing: '@napi-rs/keyring-win32-arm64-msvc' },
      'Packaged native dependency is missing',
    ],
    ['mislabeled binary', { wrongArch: true }, 'Wrong native architecture'],
    ['foreign host package', { foreign: true }, 'Foreign platform package'],
    ['packed native binding', { packed: true }, 'Native binary must be unpacked'],
    ['loader version drift', { loaderDrift: true }, 'Packaged native loader differs from lock'],
  ] as const) {
    it(`rejects ${label} in the final ASAR`, async () => {
      let error: unknown;
      try {
        await verifyNativeDependencies(await makeArchive('win32', 'arm64', options));
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).to.contain(expected);
    });
  }
});
