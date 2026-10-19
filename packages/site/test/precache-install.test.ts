import { expect } from 'chai';
import { installOfflineAssets } from '../src/precache-install.js';

describe('complete offline installation', () => {
  it('uses bounded parallel downloads and waits for every entry', async () => {
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];
    await installOfflineAssets(
      Array.from({ length: 30 }, (_, i) => i),
      async (entry) => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        completed.push(entry);
        active--;
      },
    );
    expect(maximum).to.equal(4);
    expect(completed).to.have.length(30);
    expect(active).to.equal(0);
  });

  it('recovers a transient failure without claiming success for a missing asset', async () => {
    const attempts = new Map<string, number>();
    await installOfflineAssets(['app', 'font', 'worker'], async (entry) => {
      const count = (attempts.get(entry) ?? 0) + 1;
      attempts.set(entry, count);
      if (entry === 'font' && count === 1) throw new Error('temporary network error');
    });
    expect(attempts.get('font')).to.equal(2);
  });

  it('rejects persistent failures after one retry and drains in-flight writes', async () => {
    let failedAttempts = 0;
    let writing = false;
    let failure: unknown;
    try {
      await installOfflineAssets(['bad', 'slow'], async (entry) => {
        if (entry === 'bad') {
          failedAttempts++;
          throw new Error('quota');
        }
        writing = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        writing = false;
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.equal('quota');
    expect(failedAttempts).to.equal(2);
    expect(writing).to.equal(false);
  });
});
