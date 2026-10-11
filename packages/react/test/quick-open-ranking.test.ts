import { expect } from 'chai';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import type { IndexedDocument, WorkspaceIndexFile } from '@bendyline/docblocks/workspace-index';
import { rankQuickOpen, type QuickOpenInput } from '../src/QuickOpen/quick-open-ranking.js';

function file(path: string, lastModified = '2026-01-01T00:00:00.000Z'): WorkspaceIndexFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    path: parseWorkspacePath(path),
    name,
    size: 1,
    lastModified,
    kind: name.endsWith('.md') ? 'markdown' : 'other',
  };
}

function titled(path: string, title: string): IndexedDocument {
  return {
    path: parseWorkspacePath(path),
    sourcePath: parseWorkspacePath(path),
    format: 'markdown',
    lastModified: '2026-01-01T00:00:00.000Z',
    title,
    outline: [],
    wordCount: 0,
    content: 'full',
  };
}

function input(overrides: Partial<QuickOpenInput>): QuickOpenInput {
  return {
    query: '',
    workspaceId: 'ws',
    files: [],
    documents: [],
    recent: [],
    pins: [],
    activePath: null,
    ...overrides,
  };
}

describe('quick-open ranking', () => {
  const files = [
    file('gezel-release.md', '2026-01-03T00:00:00.000Z'),
    file('notes/gezel-native-build.md', '2026-01-02T00:00:00.000Z'),
    file('archive/really-old.md', '2026-01-01T00:00:00.000Z'),
    file('images/logo.png', '2026-01-04T00:00:00.000Z'),
  ];

  it('lists recent, then pinned, then recently modified for an empty query', () => {
    const results = rankQuickOpen(
      input({
        files,
        recent: ['archive/really-old.md', 'gezel-release.md'],
        pins: [{ workspaceId: 'other', workspaceName: 'Other', path: 'plan.md' }],
        activePath: 'gezel-release.md',
      }),
    );
    expect(results.map((item) => item.path)).to.deep.equal([
      'archive/really-old.md',
      'plan.md',
      'images/logo.png',
      'notes/gezel-native-build.md',
    ]);
    expect(results[1]!.workspaceName).to.equal('Other');
  });

  it('matches names, titles, and folders, highlighting each', () => {
    const results = rankQuickOpen(
      input({
        files,
        documents: [titled('archive/really-old.md', 'Quarterly Gezel Report')],
        query: 'gezel',
      }),
    );
    expect(results.map((item) => item.path)).to.include.members([
      'gezel-release.md',
      'notes/gezel-native-build.md',
      'archive/really-old.md',
    ]);
    const titleHit = results.find((item) => item.path === 'archive/really-old.md')!;
    expect(titleHit.title).to.equal('Quarterly Gezel Report');
    expect(titleHit.titleRanges).to.deep.equal([[10, 15]]);
    expect(results[0]!.nameRanges).to.deep.equal([[0, 5]]);
  });

  it('lets a clearly better match outrank a recent one', () => {
    const results = rankQuickOpen(
      input({ files, query: 'gezel-release', recent: ['notes/gezel-native-build.md'] }),
    );
    expect(results[0]!.path).to.equal('gezel-release.md');
  });

  it('breaks near-ties toward recently opened documents', () => {
    const results = rankQuickOpen(
      input({
        files: [file('alpha/notes.md'), file('beta/notes.md')],
        query: 'notes',
        recent: ['beta/notes.md'],
      }),
    );
    expect(results[0]!.path).to.equal('beta/notes.md');
    expect(results[0]!.recent).to.equal(true);
  });

  it('scores a query containing a slash against the full path', () => {
    const results = rankQuickOpen(input({ files, query: 'notes/gez' }));
    expect(results[0]!.path).to.equal('notes/gezel-native-build.md');
    expect(results[0]!.folderRanges).to.deep.equal([[0, 5]]);
    expect(results[0]!.nameRanges).to.deep.equal([[0, 3]]);
  });

  it('requires every token to match', () => {
    expect(rankQuickOpen(input({ files, query: 'gezel zzz' }))).to.deep.equal([]);
  });
});
