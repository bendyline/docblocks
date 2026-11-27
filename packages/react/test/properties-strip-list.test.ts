import { expect } from 'chai';
import { offersListChoice, type StripTask } from '../src/Properties/list-choice.js';

const ACTIVE = { name: 'Active', done: false };
const DONE = { name: 'Done', done: true };

function task(bucket: string | null, buckets: StripTask['buckets']): StripTask {
  const here = buckets.find((candidate) => candidate.name === bucket);
  return { bucket, buckets, done: here?.done ?? false };
}

describe('offersListChoice', () => {
  it('leaves List out when Active and Done are the only lists', () => {
    expect(offersListChoice(task('Active', [ACTIVE, DONE]))).to.equal(false);
    expect(offersListChoice(task('Done', [ACTIVE, DONE]))).to.equal(false);
  });

  it('offers List when there is a second open list', () => {
    const buckets = [ACTIVE, { name: 'Someday', done: false }, DONE];
    expect(offersListChoice(task('Active', buckets))).to.equal(true);
    expect(offersListChoice(task('Done', buckets))).to.equal(true);
  });

  it('offers List when there is a second done list', () => {
    const buckets = [ACTIVE, DONE, { name: 'Archived', done: true }];
    expect(offersListChoice(task('Active', buckets))).to.equal(true);
  });

  it('offers List for a task at the top of the tasks folder', () => {
    expect(offersListChoice(task(null, [ACTIVE, DONE]))).to.equal(true);
  });
});
