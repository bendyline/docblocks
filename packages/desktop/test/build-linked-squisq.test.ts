import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLinkedSquisq,
  lastBuiltAt,
  linkedSquisqPackages,
  newestBuildInput,
  type LinkedSquisqPackage,
} from '../../../scripts/build-linked-squisq.js';

// Directory symlinks need a privilege on Windows that junctions do not, and
// Node reports both through lstat().isSymbolicLink().
const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

const BUILT = new Date('2026-01-01T00:00:00Z');
const BEFORE = new Date('2025-12-01T00:00:00Z');
const AFTER = new Date('2026-02-01T00:00:00Z');
const REBUILT = new Date('2026-03-01T00:00:00Z');

interface Fixture {
  base: string;
  root: string;
  sibling: string;
}

function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-build-linked-squisq-'));
  const root = path.join(base, 'docblocks');
  const sibling = path.join(base, 'squisq');
  fs.mkdirSync(path.join(root, 'node_modules', '@bendyline'), { recursive: true });
  fs.mkdirSync(path.join(sibling, 'packages'), { recursive: true });
  return { base, root, sibling };
}

function writeFile(file: string, time: Date): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\n');
  fs.utimesSync(file, time, time);
}

/** A Squisq package whose sources predate a complete build. */
function addSiblingPackage(fixture: Fixture, dir: string): string {
  const packageDir = path.join(fixture.sibling, 'packages', dir);
  writeFile(path.join(packageDir, 'package.json'), BEFORE);
  writeFile(path.join(packageDir, 'src', 'index.ts'), BEFORE);
  writeFile(path.join(packageDir, 'dist', 'index.js'), BUILT);
  writeFile(path.join(packageDir, 'dist', 'index.d.ts'), BUILT);
  return packageDir;
}

function link(fixture: Fixture, name: string, packageDir: string): void {
  fs.symlinkSync(
    packageDir,
    path.join(fixture.root, 'node_modules', '@bendyline', name),
    SYMLINK_TYPE,
  );
}

/** Stands in for `npm run build`: rewrites the package's outputs. */
function recordingBuild(built: string[], status = 0) {
  return (pkg: LinkedSquisqPackage): number => {
    built.push(pkg.name);
    if (status === 0) {
      writeFile(path.join(pkg.dir, 'dist', 'index.js'), REBUILT);
      writeFile(path.join(pkg.dir, 'dist', 'index.d.ts'), REBUILT);
    }
    return status;
  };
}

describe('build-linked-squisq', () => {
  let fixture: Fixture;
  let messages: string[];
  const log = (message: string) => messages.push(message);

  beforeEach(() => {
    fixture = makeFixture();
    messages = [];
  });

  afterEach(() => {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  });

  it('does nothing when Squisq comes from the registry', () => {
    fs.mkdirSync(path.join(fixture.root, 'node_modules', '@bendyline', 'squisq'));
    const built: string[] = [];
    expect(buildLinkedSquisq({ root: fixture.root, build: recordingBuild(built), log })).to.equal(
      0,
    );
    expect(built).to.deep.equal([]);
    expect(messages).to.deep.equal([]);
  });

  it('lists linked packages in Squisq build order, not link order', () => {
    const editor = addSiblingPackage(fixture, 'editor-react');
    const core = addSiblingPackage(fixture, 'core');
    link(fixture, 'squisq-editor-react', editor);
    link(fixture, 'squisq', core);
    expect(linkedSquisqPackages(fixture.root).map((pkg) => pkg.name)).to.deep.equal([
      '@bendyline/squisq',
      '@bendyline/squisq-editor-react',
    ]);
  });

  it('leaves current packages alone and rebuilds one whose source changed', () => {
    const core = addSiblingPackage(fixture, 'core');
    const editor = addSiblingPackage(fixture, 'editor-react');
    link(fixture, 'squisq', core);
    link(fixture, 'squisq-editor-react', editor);
    writeFile(path.join(editor, 'src', 'PreviewControls.tsx'), AFTER);

    const built: string[] = [];
    expect(buildLinkedSquisq({ root: fixture.root, build: recordingBuild(built), log })).to.equal(
      0,
    );
    expect(built).to.deep.equal(['@bendyline/squisq-editor-react']);
    expect(messages[0]).to.include('src/PreviewControls.tsx changed since its last build');
    expect(messages.at(-1)).to.include('1 rebuilt, 1 already current');
  });

  it('ignores tests and fixtures, which never reach dist', () => {
    const core = addSiblingPackage(fixture, 'core');
    writeFile(path.join(core, 'src', '__tests__', 'fixtures', 'doc.md'), AFTER);
    writeFile(path.join(core, 'src', 'parse.test.ts'), AFTER);
    expect(newestBuildInput(core)?.mtimeMs).to.equal(BEFORE.getTime());

    writeFile(path.join(core, 'tsup.config.ts'), AFTER);
    expect(newestBuildInput(core)?.file).to.equal(path.join(core, 'tsup.config.ts'));
  });

  it('rebuilds a package that has never been built', () => {
    const core = addSiblingPackage(fixture, 'core');
    fs.rmSync(path.join(core, 'dist'), { recursive: true });
    link(fixture, 'squisq', core);

    const built: string[] = [];
    buildLinkedSquisq({ root: fixture.root, build: recordingBuild(built), log });
    expect(built).to.deep.equal(['@bendyline/squisq']);
    expect(messages[0]).to.include('never been built');
  });

  it('treats a build whose declarations failed as stale', () => {
    const core = addSiblingPackage(fixture, 'core');
    writeFile(path.join(core, 'src', 'index.ts'), AFTER);
    // Code emitted after the edit, declarations left over from the build before.
    writeFile(path.join(core, 'dist', 'index.js'), new Date(AFTER.getTime() + 1000));
    expect(lastBuiltAt(core)).to.equal(BUILT.getTime());
  });

  it('rebuilds packages that embed a rebuilt sibling, and only those', () => {
    const core = addSiblingPackage(fixture, 'core');
    const formats = addSiblingPackage(fixture, 'formats');
    const react = addSiblingPackage(fixture, 'react');
    const cli = addSiblingPackage(fixture, 'cli');
    link(fixture, 'squisq', core);
    link(fixture, 'squisq-formats', formats);
    link(fixture, 'squisq-react', react);
    link(fixture, 'squisq-cli', cli);
    writeFile(path.join(core, 'src', 'index.ts'), AFTER);

    const built: string[] = [];
    buildLinkedSquisq({ root: fixture.root, build: recordingBuild(built), log });
    // formats imports core as an external; react's standalone player inlines
    // it, and the CLI copies that player.
    expect(built).to.deep.equal([
      '@bendyline/squisq',
      '@bendyline/squisq-react',
      '@bendyline/squisq-cli',
    ]);
    expect(messages[1]).to.include('embeds @bendyline/squisq');
  });

  it('stops at the first failed build and returns its exit code', () => {
    const core = addSiblingPackage(fixture, 'core');
    const editor = addSiblingPackage(fixture, 'editor-react');
    link(fixture, 'squisq', core);
    link(fixture, 'squisq-editor-react', editor);
    writeFile(path.join(core, 'src', 'index.ts'), AFTER);
    writeFile(path.join(editor, 'src', 'index.ts'), AFTER);

    const built: string[] = [];
    expect(
      buildLinkedSquisq({ root: fixture.root, build: recordingBuild(built, 2), log }),
    ).to.equal(2);
    expect(built).to.deep.equal(['@bendyline/squisq']);
    expect(messages.at(-1)).to.include('failed to build (exit code 2)');
  });
});
