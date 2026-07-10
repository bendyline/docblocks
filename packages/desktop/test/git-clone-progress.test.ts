/**
 * Tests for clone-progress — the stateful `git clone --progress` stderr
 * parser: chunk buffering, \r-separated in-place updates, remote: prefix
 * stripping, deduplication, and unrecognized-line filtering.
 */

import { expect } from 'chai';
import type { GitCloneProgress } from '@bendyline/docblocks/host';
import { createCloneProgressParser } from '../main/git/clone-progress.js';

function collect(): { events: GitCloneProgress[]; feed: (chunk: string) => void } {
  const events: GitCloneProgress[] = [];
  const feed = createCloneProgressParser((p) => events.push(p));
  return { events, feed };
}

describe('createCloneProgressParser', () => {
  it('parses a percent line into phase, percent, and detail', () => {
    const { events, feed } = collect();
    feed('Receiving objects:  42% (123/291)\r');
    expect(events).to.deep.equal([
      {
        phase: 'Receiving objects',
        percent: 42,
        detail: 'Receiving objects:  42% (123/291)',
      },
    ]);
  });

  it('reassembles lines split across chunks', () => {
    const { events, feed } = collect();
    feed('Receiving obj');
    expect(events).to.have.length(0);
    feed('ects:  42% (123/291)\r');
    expect(events).to.have.length(1);
    expect(events[0].phase).to.equal('Receiving objects');
    expect(events[0].percent).to.equal(42);
  });

  it('does not emit a buffered partial line until it is terminated', () => {
    const { events, feed } = collect();
    feed('Resolving deltas:  50% (5/10)');
    expect(events).to.have.length(0);
    feed('\n');
    expect(events).to.have.length(1);
  });

  it('emits increasing percents from \\r-separated in-place updates', () => {
    const { events, feed } = collect();
    feed(
      'Receiving objects:  10% (29/291)\rReceiving objects:  42% (123/291)\rReceiving objects: 100% (291/291)\n',
    );
    expect(events.map((e) => e.percent)).to.deep.equal([10, 42, 100]);
    expect(events.every((e) => e.phase === 'Receiving objects')).to.equal(true);
  });

  it('dedupes identical consecutive phase+percent events', () => {
    const { events, feed } = collect();
    feed('Receiving objects:  42% (123/291)\r');
    feed('Receiving objects:  42% (124/291)\r');
    feed('Receiving objects:  43% (125/291)\r');
    expect(events.map((e) => e.percent)).to.deep.equal([42, 43]);
  });

  it('does not dedupe when the same percent recurs in a different phase', () => {
    const { events, feed } = collect();
    feed('Receiving objects: 100% (291/291), done.\n');
    feed('Resolving deltas: 100% (10/10), done.\n');
    expect(events.map((e) => e.phase)).to.deep.equal(['Receiving objects', 'Resolving deltas']);
  });

  it('strips the remote: prefix but keeps the raw line as detail', () => {
    const { events, feed } = collect();
    feed('remote: Compressing objects: 100% (12/12), done.\n');
    expect(events).to.deep.equal([
      {
        phase: 'Compressing objects',
        percent: 100,
        detail: 'remote: Compressing objects: 100% (12/12), done.',
      },
    ]);
  });

  it('parses remote count lines without a percent', () => {
    const { events, feed } = collect();
    feed('remote: Counting objects: 5, done.\n');
    expect(events).to.deep.equal([
      {
        phase: 'Counting objects',
        percent: null,
        detail: 'remote: Counting objects: 5, done.',
      },
    ]);
  });

  it("recognizes Cloning into '...' lines", () => {
    const { events, feed } = collect();
    feed("Cloning into 'docblocks'...\n");
    expect(events).to.deep.equal([
      { phase: 'Cloning into', percent: null, detail: "Cloning into 'docblocks'..." },
    ]);
  });

  it('parses done lines with a percent', () => {
    const { events, feed } = collect();
    feed('Resolving deltas: 100% (10/10), done.\n');
    expect(events).to.deep.equal([
      { phase: 'Resolving deltas', percent: 100, detail: 'Resolving deltas: 100% (10/10), done.' },
    ]);
  });

  it('dedupes the in-place 100% update against its final done line', () => {
    const { events, feed } = collect();
    feed('Resolving deltas: 100% (10/10)\rResolving deltas: 100% (10/10), done.\n');
    expect(events).to.have.length(1);
    expect(events[0].percent).to.equal(100);
  });

  it('parses Checking out files progress', () => {
    const { events, feed } = collect();
    feed('Checking out files:  50% (1/2)\r');
    expect(events).to.deep.equal([
      { phase: 'Checking out files', percent: 50, detail: 'Checking out files:  50% (1/2)' },
    ]);
  });

  it('ignores empty and unrecognized lines', () => {
    const { events, feed } = collect();
    feed('\n');
    feed('   \n');
    feed('warning: something odd happened\n');
    feed('fatal: repository not found\n');
    feed('Total 291 (delta 10), reused 291 (delta 10)\n');
    expect(events).to.have.length(0);
  });

  it('handles a realistic interleaved stream', () => {
    const { events, feed } = collect();
    feed("Cloning into 'repo'...\nremote: Enumerating objects: 291, done.\n");
    feed('remote: Counting objects: 100% (291/291), done.\n');
    feed('Receiving objects:  10% (29/2');
    feed('91)\rReceiving objects: 100% (291/291), done.\n');
    feed('Resolving deltas: 100% (10/10), done.\n');
    expect(events.map((e) => [e.phase, e.percent])).to.deep.equal([
      ['Cloning into', null],
      ['Enumerating objects', null],
      ['Counting objects', 100],
      ['Receiving objects', 10],
      ['Receiving objects', 100],
      ['Resolving deltas', 100],
    ]);
  });
});
