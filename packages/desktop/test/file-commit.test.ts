import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteBinary,
  atomicWriteText,
  commitBinaryFile,
  commitTextFile,
  sha256,
} from '../main/file-commit.js';

describe('desktop conditional file commits', () => {
  it('allows only one text commit to replace the same baseline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-commit-'));
    const file = path.join(root, 'notes.md');
    try {
      await atomicWriteText(file, 'initial');
      const results = await Promise.all([
        commitTextFile(file, 'first', 'initial'),
        commitTextFile(file, 'second', 'initial'),
      ]);

      expect(results.filter((result) => result.status === 'committed')).to.have.length(1);
      expect(results.filter((result) => result.status === 'conflict')).to.have.length(1);
      expect(['first', 'second']).to.include(await fs.readFile(file, 'utf8'));
      expect((await fs.readdir(root)).some((name) => name.endsWith('.tmp'))).to.equal(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns the conflicting bundle snapshot and commits against its hash', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-bundle-'));
    const file = path.join(root, 'document.dbk');
    try {
      const initial = new TextEncoder().encode('initial bundle');
      const external = new TextEncoder().encode('external bundle');
      const local = new TextEncoder().encode('local bundle');
      await atomicWriteBinary(file, initial);
      const initialVersion = sha256(initial);
      await atomicWriteBinary(file, external);

      const conflict = await commitBinaryFile(file, local, initialVersion);
      expect(conflict.status).to.equal('conflict');
      if (conflict.status !== 'conflict') throw new Error('Expected conflict');
      expect(new TextDecoder().decode(conflict.data ?? new ArrayBuffer(0))).to.equal(
        'external bundle',
      );

      const committed = await commitBinaryFile(file, local, conflict.version);
      expect(committed.status).to.equal('committed');
      expect(new TextDecoder().decode(await fs.readFile(file))).to.equal('local bundle');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('re-resolves a dynamic workspace target inside the commit lock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-commit-retarget-'));
    const first = path.join(root, 'first.md');
    const second = path.join(root, 'second.md');
    try {
      await fs.writeFile(first, 'baseline');
      await fs.writeFile(second, 'other');
      let resolutions = 0;
      let failure: unknown;
      try {
        await commitTextFile(
          async () => (++resolutions === 1 ? first : second),
          'local',
          'baseline',
          [first],
        );
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.match(/physical identity before mutation/i);
      expect(await fs.readFile(first, 'utf8')).to.equal('baseline');
      expect(await fs.readFile(second, 'utf8')).to.equal('other');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
