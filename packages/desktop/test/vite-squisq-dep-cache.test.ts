import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REGISTRY_LINK_STATE,
  SQUISQ_LINK_STATE_STAMP,
  readSquisqLinkState,
  reconcileViteDepCache,
  squisqAwareViteCacheDir,
} from '../../../scripts/vite-squisq-dep-cache.js';

// Directory symlinks need a privilege on Windows that junctions do not, and
// Node reports both through lstat().isSymbolicLink().
const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

interface Fixture {
  base: string;
  root: string;
  sibling: string;
  scope: string;
}

function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-squisq-dep-cache-'));
  const root = path.join(base, 'docblocks');
  const sibling = path.join(base, 'squisq');
  const scope = path.join(root, 'node_modules', '@bendyline');
  fs.mkdirSync(scope, { recursive: true });
  for (const pkg of ['core', 'formats']) {
    fs.mkdirSync(path.join(sibling, 'packages', pkg), { recursive: true });
  }
  fs.writeFileSync(path.join(sibling, 'package-lock.json'), '{"lockfileVersion":3}\n');
  return { base, root, sibling, scope };
}

function installRegistryCopy(fixture: Fixture, name: string): void {
  const dir = path.join(fixture.scope, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
}

function linkSibling(fixture: Fixture, name: string, siblingPackage: string): void {
  const target = path.join(fixture.sibling, 'packages', siblingPackage);
  fs.symlinkSync(target, path.join(fixture.scope, name), SYMLINK_TYPE);
}

function seedCache(cacheDir: string, stamp: string | null): string {
  const bundled = path.join(cacheDir, 'deps', 'bundled.js');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, 'export {};\n');
  if (stamp !== null) {
    fs.writeFileSync(path.join(cacheDir, SQUISQ_LINK_STATE_STAMP), `${stamp}\n`);
  }
  return bundled;
}

describe('Vite dependency cache vs. Squisq link state', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  });

  describe('readSquisqLinkState', () => {
    it('reports registry copies as the registry state', () => {
      installRegistryCopy(fixture, 'squisq');
      installRegistryCopy(fixture, 'squisq-formats');
      expect(readSquisqLinkState(fixture.root)).to.deep.equal({
        linked: [],
        key: REGISTRY_LINK_STATE,
      });
    });

    it('treats a missing node_modules as the registry state', () => {
      expect(readSquisqLinkState(path.join(fixture.base, 'nowhere')).key).to.equal(
        REGISTRY_LINK_STATE,
      );
    });

    it('ignores links to non-Squisq packages in the scope', () => {
      installRegistryCopy(fixture, 'squisq');
      const workspace = path.join(fixture.base, 'workspace-package');
      fs.mkdirSync(workspace);
      fs.symlinkSync(workspace, path.join(fixture.scope, 'docblocks'), SYMLINK_TYPE);
      expect(readSquisqLinkState(fixture.root).key).to.equal(REGISTRY_LINK_STATE);
    });

    it('fingerprints which packages are linked and the sibling lockfile', () => {
      installRegistryCopy(fixture, 'squisq');
      linkSibling(fixture, 'squisq-formats', 'formats');

      const first = readSquisqLinkState(fixture.root);
      expect(first.linked).to.deep.equal(['@bendyline/squisq-formats']);
      expect(first.key).to.match(/^linked:[0-9a-f]{16}$/);
      expect(readSquisqLinkState(fixture.root).key).to.equal(first.key);

      fs.writeFileSync(path.join(fixture.sibling, 'package-lock.json'), '{"lockfileVersion":4}\n');
      const afterLockfileChange = readSquisqLinkState(fixture.root);
      expect(afterLockfileChange.key).to.not.equal(first.key);

      fs.rmSync(path.join(fixture.scope, 'squisq'), { recursive: true, force: true });
      linkSibling(fixture, 'squisq', 'core');
      const afterSecondLink = readSquisqLinkState(fixture.root);
      expect(afterSecondLink.linked).to.deep.equal([
        '@bendyline/squisq',
        '@bendyline/squisq-formats',
      ]);
      expect(afterSecondLink.key).to.not.equal(afterLockfileChange.key);
    });

    it('still distinguishes a dangling link from a registry copy', () => {
      fs.symlinkSync(
        path.join(fixture.base, 'missing-checkout'),
        path.join(fixture.scope, 'squisq'),
        SYMLINK_TYPE,
      );
      const state = readSquisqLinkState(fixture.root);
      expect(state.linked).to.deep.equal(['@bendyline/squisq']);
      expect(state.key).to.not.equal(REGISTRY_LINK_STATE);
    });
  });

  describe('reconcileViteDepCache', () => {
    it('creates the stamp without reporting a clear when no cache exists', () => {
      const cacheDir = path.join(fixture.root, 'node_modules', '.vite');
      const result = reconcileViteDepCache(cacheDir, 'linked:abc');
      expect(result).to.deep.equal({ cacheDir, key: 'linked:abc', cleared: false });
      expect(fs.readFileSync(path.join(cacheDir, SQUISQ_LINK_STATE_STAMP), 'utf8')).to.equal(
        'linked:abc\n',
      );
    });

    it('keeps a cache whose stamp matches', () => {
      const cacheDir = path.join(fixture.root, 'node_modules', '.vite');
      const bundled = seedCache(cacheDir, 'linked:abc');
      expect(reconcileViteDepCache(cacheDir, 'linked:abc').cleared).to.equal(false);
      expect(fs.existsSync(bundled)).to.equal(true);
    });

    it('discards a cache built under another state and restamps it', () => {
      const cacheDir = path.join(fixture.root, 'node_modules', '.vite');
      const bundled = seedCache(cacheDir, REGISTRY_LINK_STATE);
      expect(reconcileViteDepCache(cacheDir, 'linked:abc').cleared).to.equal(true);
      expect(fs.existsSync(bundled)).to.equal(false);
      expect(fs.readFileSync(path.join(cacheDir, SQUISQ_LINK_STATE_STAMP), 'utf8')).to.equal(
        'linked:abc\n',
      );
    });

    it('discards a cache that carries no stamp at all', () => {
      const cacheDir = path.join(fixture.root, 'node_modules', '.vite');
      const bundled = seedCache(cacheDir, null);
      expect(reconcileViteDepCache(cacheDir, REGISTRY_LINK_STATE).cleared).to.equal(true);
      expect(fs.existsSync(bundled)).to.equal(false);
    });
  });

  describe('squisqAwareViteCacheDir', () => {
    const originalWarn = console.warn;
    let warnings: string[];

    beforeEach(() => {
      warnings = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
    });

    afterEach(() => {
      console.warn = originalWarn;
    });

    it('pins the cache under the surface package and stamps the current state', () => {
      installRegistryCopy(fixture, 'squisq');
      const packageDir = path.join(fixture.root, 'packages', 'site');
      fs.mkdirSync(packageDir, { recursive: true });

      const cacheDir = squisqAwareViteCacheDir(packageDir, fixture.root);
      expect(cacheDir).to.equal(path.join(packageDir, 'node_modules', '.vite'));
      expect(fs.readFileSync(path.join(cacheDir, SQUISQ_LINK_STATE_STAMP), 'utf8')).to.equal(
        `${REGISTRY_LINK_STATE}\n`,
      );
      expect(warnings).to.deep.equal([]);
    });

    it('clears a cache from the other link state exactly once and says so', () => {
      linkSibling(fixture, 'squisq', 'core');
      const packageDir = path.join(fixture.root, 'packages', 'desktop');
      const cacheDir = path.join(packageDir, 'node_modules', '.vite');
      const bundled = seedCache(cacheDir, REGISTRY_LINK_STATE);

      squisqAwareViteCacheDir(packageDir, fixture.root);
      expect(fs.existsSync(bundled)).to.equal(false);
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include('@bendyline/squisq');
      expect(warnings[0]).to.include(cacheDir);

      squisqAwareViteCacheDir(packageDir, fixture.root);
      expect(warnings).to.have.length(1);
    });
  });
});
