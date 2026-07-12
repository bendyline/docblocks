import { expect } from 'chai';
import { WorkspaceAuthorityBarrier } from '../src/DocBlocksShell/workspace-authority-barrier.js';

describe('WorkspaceAuthorityBarrier', () => {
  it('holds an OS open for a repaired workspace id until reconciliation publishes it', async () => {
    const barrier = new WorkspaceAuthorityBarrier();
    const descriptors = new Set<string>();
    let opened = false;

    const pendingOpen = (async () => {
      await barrier.wait();
      opened = descriptors.has('sha256-repaired-id');
    })();

    await Promise.resolve();
    expect(opened).to.equal(false);
    descriptors.add('sha256-repaired-id');
    barrier.markReady();
    await pendingOpen;
    expect(opened).to.equal(true);
  });

  it('preserves OS-open priority over a stale last-state continuation', async () => {
    const barrier = new WorkspaceAuthorityBarrier();
    let currentGeneration = 1;
    const startupGeneration = currentGeneration;
    let restoredLastState = false;
    let openedOsFile = false;

    const startup = (async () => {
      await barrier.wait();
      if (startupGeneration === currentGeneration) restoredLastState = true;
    })();

    const osGeneration = ++currentGeneration;
    const osOpen = (async () => {
      await barrier.wait();
      if (osGeneration === currentGeneration) openedOsFile = true;
    })();

    barrier.markReady();
    await Promise.all([startup, osOpen]);
    expect(restoredLastState).to.equal(false);
    expect(openedOsFile).to.equal(true);
  });

  it('is idempotent when multiple Strict Mode startup effects complete', async () => {
    const barrier = new WorkspaceAuthorityBarrier();
    barrier.markReady();
    barrier.markReady();
    await barrier.wait();
  });
});
