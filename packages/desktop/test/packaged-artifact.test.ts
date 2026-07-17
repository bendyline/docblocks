import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidateExecutables } from '../e2e/packaged-artifact.js';

describe('packaged desktop artifact discovery', () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-packaged-artifacts-'));
  });

  afterEach(() => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  function addUnpackedDirectory(name: string): string {
    const directory = path.join(artifactsDir, name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  it('does not select a stale Windows artifact for another architecture', () => {
    const arm64 = addUnpackedDirectory('win-arm64-unpacked');
    const x64 = addUnpackedDirectory('win-unpacked');

    expect(candidateExecutables(artifactsDir, 'win32', 'x64')).to.deep.equal([
      path.join(x64, 'DocBlocks.exe'),
    ]);
    expect(candidateExecutables(artifactsDir, 'win32', 'arm64')).to.deep.equal([
      path.join(arm64, 'DocBlocks.exe'),
    ]);
  });

  it('uses a macOS universal artifact only after a native-architecture artifact', () => {
    const arm64 = addUnpackedDirectory('mac-arm64');
    const universal = addUnpackedDirectory('mac-universal');
    addUnpackedDirectory('mac');

    expect(candidateExecutables(artifactsDir, 'darwin', 'arm64')).to.deep.equal([
      path.join(arm64, 'DocBlocks.app', 'Contents', 'MacOS', 'DocBlocks'),
      path.join(universal, 'DocBlocks.app', 'Contents', 'MacOS', 'DocBlocks'),
    ]);
  });

  it('does not select a stale Linux artifact for another architecture', () => {
    const arm64 = addUnpackedDirectory('linux-arm64-unpacked');
    const x64 = addUnpackedDirectory('linux-unpacked');

    expect(candidateExecutables(artifactsDir, 'linux', 'x64')).to.deep.equal(
      ['docblocks-desktop', 'docblocks', 'DocBlocks'].map((name) => path.join(x64, name)),
    );
    expect(candidateExecutables(artifactsDir, 'linux', 'arm64')).to.deep.equal(
      ['docblocks-desktop', 'docblocks', 'DocBlocks'].map((name) => path.join(arm64, name)),
    );
  });
});
