import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createUpdaterLog,
  PREVIOUS_UPDATER_LOG_FILE,
  UPDATER_LOG_FILE,
} from '../main/updater-log.js';

const FIXED_TIME = () => new Date('2026-10-29T23:22:28.128Z');

describe('desktop updater log', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'docblocks-updater-log-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps electron-updater messages and raw errors in a log folder it creates', async () => {
    const logs = path.join(directory, 'logs');
    const log = createUpdaterLog(logs, FIXED_TIME);

    log.info('Checking for update');
    log.error(new Error('Command failed: powershell.exe'));

    const lines = (await readFile(path.join(logs, UPDATER_LOG_FILE), 'utf8')).split('\n');
    expect(lines[0]).to.equal('2026-10-29T23:22:28.128Z INFO Checking for update');
    expect(lines[1]).to.match(
      /^2026-10-29T23:22:28\.128Z ERROR Error: Command failed: powershell\.exe/,
    );
    expect(lines.join('\n')).to.contain('updater-log.test.ts');
  });

  it('starts a fresh log once the current one passes 1 MiB, keeping one previous', async () => {
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    await writeFile(path.join(directory, UPDATER_LOG_FILE), oversized);

    createUpdaterLog(directory, FIXED_TIME).warn('fresh');

    expect(await readFile(path.join(directory, PREVIOUS_UPDATER_LOG_FILE), 'utf8')).to.equal(
      oversized,
    );
    expect(await readFile(path.join(directory, UPDATER_LOG_FILE), 'utf8')).to.equal(
      '2026-10-29T23:22:28.128Z WARN fresh\n',
    );
  });

  it('never throws when the log cannot be written', async () => {
    // A file where the folder should be makes every write fail.
    const blocked = path.join(directory, 'not-a-folder');
    await writeFile(blocked, '');
    const log = createUpdaterLog(blocked, FIXED_TIME);
    expect(() => log.error('still fine')).to.not.throw();
  });
});
