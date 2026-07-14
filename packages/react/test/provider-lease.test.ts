import { expect } from 'chai';
import type { FileSystemProviderV2 } from '@bendyline/docblocks/filesystem';
import { retainFileSystemProvider } from '../src/provider-lease.js';

describe('filesystem provider leases', () => {
  it('survives the Strict Mode setup-cleanup-setup cycle', async () => {
    const provider = providerSpy();
    const firstRelease = retainFileSystemProvider(provider.value);
    firstRelease();
    const secondRelease = retainFileSystemProvider(provider.value);
    await microtasks();
    expect(provider.disposeCalls).to.equal(0);

    secondRelease();
    await microtasks();
    expect(provider.disposeCalls).to.equal(1);
  });

  it('disposes only after the last holder releases and makes release idempotent', async () => {
    const provider = providerSpy();
    const releaseA = retainFileSystemProvider(provider.value);
    const releaseB = retainFileSystemProvider(provider.value);
    releaseA();
    releaseA();
    await microtasks();
    expect(provider.disposeCalls).to.equal(0);

    releaseB();
    await microtasks();
    expect(provider.disposeCalls).to.equal(1);
  });
});

function providerSpy(): { readonly value: FileSystemProviderV2; readonly disposeCalls: number } {
  let calls = 0;
  const value = {
    dispose: async () => {
      calls += 1;
    },
  } as unknown as FileSystemProviderV2;
  return {
    value,
    get disposeCalls() {
      return calls;
    },
  };
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
