import { expect } from 'chai';
import { retryUntilSuiteStarts } from '../desktop-e2e/suite-marker.js';

/** A launch that fails with `errors[n]` on attempt n + 1, then succeeds. */
function launcher(errors: Error[]) {
  const attempts: number[] = [];
  const launch = async (attempt: number): Promise<void> => {
    attempts.push(attempt);
    const error = errors[attempt - 1];
    if (error) throw error;
  };
  return { attempts, launch };
}

describe('desktop extension-host startup retry', () => {
  it('relaunches VS Code when it exits before the suite starts', async () => {
    // VS Code exits with code 1 when its first window is reported unresponsive.
    const { attempts, launch } = launcher([new Error('Test run failed with code 1')]);
    const retried: unknown[] = [];
    await retryUntilSuiteStarts(launch, () => false, {
      attempts: 2,
      onRetry: (error) => retried.push(error),
    });
    expect(attempts).to.deep.equal([1, 2]);
    expect(retried).to.have.length(1);
  });

  it('never retries a failure once the suite has started', async () => {
    const failure = new Error('Test run failed with code 1');
    const { attempts, launch } = launcher([failure]);
    let caught: unknown;
    try {
      await retryUntilSuiteStarts(launch, () => true, { attempts: 2, onRetry: () => {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(failure);
    expect(attempts).to.deep.equal([1]);
  });

  it('reports the last startup failure once its attempts run out', async () => {
    const last = new Error('second launch hung');
    const { attempts, launch } = launcher([new Error('first launch hung'), last]);
    let caught: unknown;
    try {
      await retryUntilSuiteStarts(launch, () => false, { attempts: 2, onRetry: () => {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(last);
    expect(attempts).to.deep.equal([1, 2]);
  });

  it('launches once when the first launch succeeds', async () => {
    const { attempts, launch } = launcher([]);
    await retryUntilSuiteStarts(launch, () => false, { attempts: 2, onRetry: () => {} });
    expect(attempts).to.deep.equal([1]);
  });
});
