import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DocumentSession, type DocumentSessionConflict } from '@bendyline/docblocks/document';
import {
  DocumentConflictBanner,
  DocumentConflictNotice,
  type DocumentConflictBannerProps,
} from '../src/DocBlocksShell/DocumentConflictBanner.js';
import { dismissConflict, isConflictDismissed } from '../src/DocBlocksShell/conflict-dismissal.js';
import { describeAge, describeConflictVersions } from '../src/DocBlocksShell/conflict-summary.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');

describe('Document conflict banner', () => {
  let container: HTMLDivElement;
  let root: Root;
  let compares: number;
  let dismissals: number;
  let props: DocumentConflictBannerProps;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    compares = dismissals = 0;
    props = {
      conflict: {
        targetKey: 'workspace:notes.md',
        localContent: 'a'.repeat(318),
        localRevision: 3,
        localEditedAt: Date.now() - 3 * 60_000,
        externalContent: 'b'.repeat(320),
        externalVersion: 'v2',
      },
      readSavedFile: async () => ({
        content: 'b'.repeat(320),
        lastModified: new Date(Date.now() - 25_000).toISOString(),
      }),
      onCompare: () => compares++,
      onDismiss: () => dismissals++,
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => root.render(createElement(DocumentConflictBanner, props)));
  }

  async function click(text: string) {
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === text,
    );
    expect(button, text).not.to.equal(undefined);
    await act(async () => button!.click());
  }

  it('summarizes both versions in plain language outside the live alert', async () => {
    await render();
    const details = container.querySelector('.db-document-conflict-details')?.textContent;
    expect(details).to.equal(
      'Your version: 318 characters, edited 3 minutes ago. Saved file: 320 characters, updated 20 seconds ago.',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).not.to.include('characters');
  });

  it('offers both comparison and dismissal', async () => {
    await render();
    await click('Compare versions');
    await click('Dismiss');
    expect(compares).to.equal(1);
    expect(dismissals).to.equal(1);
  });

  it('says saving is paused before the user can dismiss it', async () => {
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).to.include('saving is paused');
  });

  it('leaves a notice after dismissal that leads back to the banner', async () => {
    let reviews = 0;
    await act(async () =>
      root.render(createElement(DocumentConflictNotice, { onReview: () => reviews++ })),
    );
    expect(container.querySelector('[role="status"]')?.textContent).to.include('Saving paused');
    await click('Review');
    expect(reviews).to.equal(1);
  });

  it('omits a save time that belongs to a different file version', async () => {
    props.readSavedFile = async () => ({
      content: 'changed again',
      lastModified: new Date().toISOString(),
    });
    await render();
    expect(container.querySelector('.db-document-conflict-details')?.textContent).to.include(
      'Saved file: 320 characters.',
    );
  });

  it('still describes the local version when file metadata cannot be read', async () => {
    props.readSavedFile = async () => {
      throw new Error('permission denied');
    };
    await render();
    expect(container.querySelector('.db-document-conflict-details')?.textContent).to.include(
      'Your version: 318 characters, edited 3 minutes ago.',
    );
  });
});

describe('conflict dismissal', () => {
  async function conflictedSession() {
    const session = new DocumentSession({ autoSaveDelayMs: 5 });
    await session.transitionTo({ key: 'ws:a.md', commit: async () => undefined }, 'v0');
    const scope = () => {
      const snapshot = session.getSnapshot();
      return { targetKey: snapshot.targetKey!, generation: snapshot.generation };
    };
    session.edit('v0 + my edit', scope());
    session.observeExternal({ targetKey: 'ws:a.md', content: 'outside v1', version: 1 });
    return { session, scope };
  }

  it('stays dismissed while the user keeps typing', async () => {
    const { session, scope } = await conflictedSession();
    const dismissed = dismissConflict(session.getSnapshot().conflict!);
    session.edit('v0 + my edit, and more', scope());
    expect(isConflictDismissed(session.getSnapshot().conflict!, dismissed)).to.equal(true);
  });

  it('returns for a newer outside change to the same file', async () => {
    const { session, scope } = await conflictedSession();
    const dismissed = dismissConflict(session.getSnapshot().conflict!);
    session.observeExternal({ targetKey: 'ws:a.md', content: 'outside v2', version: 2 });
    session.edit('v0 + my edit, typed after', scope());
    expect(session.getSnapshot().status).to.equal('conflict');
    expect(isConflictDismissed(session.getSnapshot().conflict!, dismissed)).to.equal(false);
  });

  it('is never dismissed without a dismissal', async () => {
    const { session } = await conflictedSession();
    expect(isConflictDismissed(session.getSnapshot().conflict!, null)).to.equal(false);
  });
});

describe('describeConflictVersions', () => {
  const base: DocumentSessionConflict = {
    targetKey: 'workspace:notes.md',
    localContent: 'Hi 💡',
    localRevision: 1,
    externalContent: null,
    externalVersion: null,
  };

  it('counts characters rather than UTF-16 code units and reports a deletion', () => {
    expect(describeConflictVersions(base, undefined, NOW)).to.equal(
      'Your version: 4 characters. The saved file was deleted.',
    );
  });

  it('dates a recovery draft by its capture time until it is edited again', () => {
    const recovered = {
      ...base,
      recoveredDraft: true,
      recoveredDraftCapturedAt: NOW - 2 * 86_400_000 - 1,
    };
    expect(describeConflictVersions(recovered, undefined, NOW)).to.match(
      /^Recovery draft: 4 characters, edited 2 days ago\./,
    );
    expect(
      describeConflictVersions({ ...recovered, localEditedAt: NOW - 1_000 }, undefined, NOW),
    ).to.match(/^Recovery draft: 4 characters, edited just now\./);
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
