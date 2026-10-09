import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLinkedGezel, gezelBuildPackages } from '../../../scripts/build-linked-gezel.js';
import {
  GEZEL_PACKAGES,
  linkGezel,
  linkedGezelRoot,
  repoRoot,
  unlinkGezel,
} from '../../../scripts/gezel-links.js';

describe('local Gezel links', () => {
  let base: string;
  let root: string;
  let source: string;

  function write(file: string, text: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  function workspace(dir: string, name: string, dependencies = {}, extras = {}) {
    write(
      path.join(source, 'packages', dir, 'package.json'),
      JSON.stringify({
        name,
        scripts: { build: 'tsup' },
        dependencies,
        ...extras,
      }),
    );
  }

  const installed = (name: string) => path.join(root, 'packages/desktop/node_modules', name);

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-gezel-links-')));
    root = path.join(base, 'docblocks');
    source = path.join(base, 'gezel');
    for (const [dir, name] of GEZEL_PACKAGES) {
      workspace(dir, name);
      write(
        path.join(installed(name), 'package.json'),
        JSON.stringify({ name, version: 'registry' }),
      );
      write(path.join(installed(name), 'dist/index.js'), 'original registry bytes');
    }
  });

  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('leaves registry installs usable without a sibling checkout', () => {
    fs.rmSync(source, { recursive: true });
    expect(linkedGezelRoot(root)).to.equal(null);
    expect(() => linkedGezelRoot(root, true)).to.throw('links are missing');
  });

  it('links desktop-local packages, is repeatable, and restores exact installed bytes', () => {
    const lock = path.join(root, 'package-lock.json');
    write(lock, 'unchanged lockfile');
    const rootSdk = path.join(root, 'node_modules/@bendyline/gezel-app-sdk/package.json');
    write(rootSdk, 'other workspace SDK');
    linkGezel(root);
    linkGezel(root);
    expect(linkedGezelRoot(root)).to.equal(source);
    for (const [dir, name] of GEZEL_PACKAGES) {
      expect(fs.realpathSync(installed(name))).to.equal(path.join(source, 'packages', dir));
    }
    unlinkGezel(root);
    expect(linkedGezelRoot(root)).to.equal(null);
    for (const [, name] of GEZEL_PACKAGES) {
      expect(fs.lstatSync(installed(name)).isSymbolicLink()).to.equal(false);
      expect(fs.readFileSync(path.join(installed(name), 'dist/index.js'), 'utf8')).to.equal(
        'original registry bytes',
      );
    }
    expect(fs.readFileSync(lock, 'utf8')).to.equal('unchanged lockfile');
    expect(fs.readFileSync(rootSdk, 'utf8')).to.equal('other workspace SDK');
  });

  it('validates every source before replacing any installed package', () => {
    fs.rmSync(path.join(source, 'packages/service'), { recursive: true });
    expect(() => linkGezel(root)).to.throw();
    for (const [, name] of GEZEL_PACKAGES) {
      expect(fs.lstatSync(installed(name)).isSymbolicLink()).to.equal(false);
    }
  });

  it('fails if npm replaces configured links with registry packages', () => {
    linkGezel(root);
    for (const [, name] of GEZEL_PACKAGES) {
      fs.unlinkSync(installed(name));
      write(path.join(installed(name), 'package.json'), JSON.stringify({ name }));
    }
    expect(() => linkedGezelRoot(root)).to.throw('links are missing');
    expect(() => unlinkGezel(root)).to.throw('will not be overwritten');
  });

  it('refuses a partial or mixed-checkout link set', () => {
    linkGezel(root);
    const sdk = installed('@bendyline/gezel-app-sdk');
    fs.unlinkSync(sdk);
    expect(() => linkedGezelRoot(root)).to.throw('links are missing');
    const other = path.join(base, 'other/packages/app-sdk');
    fs.mkdirSync(other, { recursive: true });
    fs.symlinkSync(other, sdk, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => linkedGezelRoot(root)).to.throw('same Gezel checkout');
    expect(() => linkGezel(root)).to.throw('already links elsewhere');
  });

  it('can restore installed packages after the sibling checkout is removed', () => {
    linkGezel(root);
    fs.rmSync(source, { recursive: true });
    unlinkGezel(root);
    expect(linkedGezelRoot(root)).to.equal(null);
  });

  it('builds runtime dependencies before consumers and excludes dev/peer cycles', () => {
    workspace('core', '@bendyline/gezel', { '@bendyline/gezk': 'workspace:*' });
    workspace('gezk', '@bendyline/gezk');
    workspace('client', '@bendyline/gezel-client', { '@bendyline/gezel': 'workspace:*' });
    workspace(
      'app-sdk',
      '@bendyline/gezel-app-sdk',
      { '@bendyline/gezel-client': 'workspace:*' },
      {
        devDependencies: { '@bendyline/gezel-service': 'workspace:*' },
        peerDependencies: { '@bendyline/gezel-service': 'workspace:*' },
      },
    );
    workspace('stdlib', '@bendyline/gezel-script-stdlib', {}, { scripts: {} });
    workspace('service', '@bendyline/gezel-service', {
      '@bendyline/gezel': 'workspace:*',
      '@bendyline/gezel-client': 'workspace:*',
      '@bendyline/gezel-script-stdlib': 'workspace:*',
      'third-party': '1.0.0',
    });
    expect(gezelBuildPackages(source).map((pkg) => pkg.name)).to.deep.equal([
      '@bendyline/gezk',
      '@bendyline/gezel',
      '@bendyline/gezel-client',
      '@bendyline/gezel-app-sdk',
      '@bendyline/gezel-service',
    ]);
  });

  it('fails on a missing runtime dependency or runtime cycle', () => {
    workspace('core', '@bendyline/gezel', { missing: 'workspace:*' });
    expect(() => gezelBuildPackages(source)).to.throw('Missing Gezel workspace package');
    workspace('core', '@bendyline/gezel', { '@bendyline/gezel-service': 'workspace:*' });
    workspace('service', '@bendyline/gezel-service', { '@bendyline/gezel': 'workspace:*' });
    expect(() => gezelBuildPackages(source)).to.throw('runtime dependency cycle');
  });

  it('builds the sibling packages even when desktop startup passes an npm prefix', async () => {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, 'node_modules/npm'),
      path.join(root, 'node_modules/npm'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    write(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'exit 99' } }));
    write(
      path.join(source, 'scripts/dependency-lease.mjs'),
      `export async function withDependencyReadLease(root, run) {
      return run({ leaseEnv: { npm_config_prefix: ${JSON.stringify(root)} }, setChildPid: async () => {} });
    }`,
    );
    for (const [dir, name] of GEZEL_PACKAGES) {
      workspace(dir, name, {}, { scripts: { build: 'node build.cjs' } });
      write(
        path.join(source, 'packages', dir, 'build.cjs'),
        `const fs = require('node:fs');
        fs.mkdirSync('dist', { recursive: true });
        fs.writeFileSync('dist/index.js', process.cwd());
        fs.writeFileSync('dist/index.d.ts', 'export {}');`,
      );
    }
    linkGezel(root);
    expect(await buildLinkedGezel(root)).to.equal(0);
    for (const [dir] of GEZEL_PACKAGES) {
      const packageDir = path.join(source, 'packages', dir);
      expect(fs.readFileSync(path.join(packageDir, 'dist/index.js'), 'utf8')).to.equal(packageDir);
    }
  });
});
