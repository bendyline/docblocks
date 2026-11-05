import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import { DESKTOP_THREADPOOL_SIZE, configureThreadPool } from '../main/thread-pool.js';

describe('main-process thread pool', () => {
  it('raises the libuv pool unless the environment already sizes it', () => {
    const unset: NodeJS.ProcessEnv = {};
    configureThreadPool(unset);
    expect(unset.UV_THREADPOOL_SIZE).to.equal(String(DESKTOP_THREADPOOL_SIZE));

    const explicit: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: '8' };
    configureThreadPool(explicit);
    expect(explicit.UV_THREADPOOL_SIZE).to.equal('8');
  });

  it('is the first import of the main process, before anything can use the pool', async () => {
    const source = await readFile(new URL('../main/main.ts', import.meta.url), 'utf8');
    const firstImport = /^import\s[^;]*;/mu.exec(source)?.[0];
    expect(firstImport).to.equal("import './thread-pool.js';");
  });
});
