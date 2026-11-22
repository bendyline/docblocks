import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DocumentConflictNotice } from '../src/DocBlocksShell/DocumentConflictNotice.js';
import { describeAge } from '../src/DocBlocksShell/conflict-summary.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');

describe('Document conflict notice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('says saving is paused and leads straight to resolving it', async () => {
    let resolves = 0;
    await act(async () =>
      root.render(
        createElement(DocumentConflictNotice, {
          recoveredDraft: false,
          onResolve: () => resolves++,
        }),
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).to.equal(
      'Saving paused: this document changed outside DocBlocks.',
    );
    // One step to the comparison: nothing to dismiss, nothing in between.
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).to.deep.equal(['Resolve']);
    await act(async () => buttons[0]!.click());
    expect(resolves).to.equal(1);
  });

  it('names a recovered draft as what differs', async () => {
    await act(async () =>
      root.render(
        createElement(DocumentConflictNotice, { recoveredDraft: true, onResolve: () => {} }),
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).to.equal(
      'Saving paused: a recovered draft differs from the saved file.',
    );
  });
});

describe('describeAge', () => {
  for (const [elapsed, expected] of [
    [0, 'just now'],
    [-30_000, 'just now'],
    [9_999, 'just now'],
    [25_000, '20 seconds ago'],
    [60_000, '1 minute ago'],
    [59 * 60_000, '59 minutes ago'],
    [3 * 3_600_000, '3 hours ago'],
    [30 * 3_600_000, 'yesterday'],
    [3 * 86_400_000, '3 days ago'],
  ] as const) {
    it(`describes ${elapsed} ms as "${expected}"`, () => {
      expect(describeAge(NOW - elapsed, NOW)).to.equal(expected);
    });
  }

  it('falls back to a date for old versions and nothing for future clocks', () => {
    expect(describeAge(NOW - 30 * 86_400_000, NOW)).to.match(/^on /);
    expect(describeAge(NOW + 5 * 60_000, NOW)).to.equal(null);
  });
});
