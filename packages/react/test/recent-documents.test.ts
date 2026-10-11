import { expect } from 'chai';
import {
  RECENT_DOCUMENTS_STORAGE_KEY,
  forgetRecentDocuments,
  loadRecentDocuments,
  parseRecentDocuments,
  recordRecentDocument,
  relocateRecentDocuments,
  type RecentDocumentStorage,
} from '../src/WorkspaceIndex/recent-documents.js';

function memoryStorage(initial?: string): RecentDocumentStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === RECENT_DOCUMENTS_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === RECENT_DOCUMENTS_STORAGE_KEY) this.value = value;
    },
  };
}

describe('recent documents', () => {
  it('keeps the most recent first, de-duplicated and canonical', () => {
    const storage = memoryStorage();
    recordRecentDocument('ws', '/a.md', storage);
    recordRecentDocument('ws', 'b.md', storage);
    recordRecentDocument('ws', 'a.md', storage);
    expect(loadRecentDocuments('ws', storage)).to.deep.equal(['a.md', 'b.md']);
    expect(loadRecentDocuments('other', storage)).to.deep.equal([]);
  });

  it('caps each workspace’s history', () => {
    const storage = memoryStorage();
    for (let index = 0; index < 60; index += 1)
      recordRecentDocument('ws', `doc-${index}.md`, storage);
    const recent = loadRecentDocuments('ws', storage);
    expect(recent).to.have.length(50);
    expect(recent[0]).to.equal('doc-59.md');
  });

  it('follows file and folder moves', () => {
    const storage = memoryStorage();
    recordRecentDocument('ws', 'notes/a.md', storage);
    recordRecentDocument('ws', 'notes/deep/b.md', storage);
    recordRecentDocument('ws', 'notes-other.md', storage);
    relocateRecentDocuments('ws', 'notes', 'archive/notes', storage);
    expect(loadRecentDocuments('ws', storage)).to.deep.equal([
      'notes-other.md',
      'archive/notes/deep/b.md',
      'archive/notes/a.md',
    ]);
    relocateRecentDocuments('ws', 'notes-other.md', 'renamed.md', storage);
    expect(loadRecentDocuments('ws', storage)[0]).to.equal('renamed.md');
  });

  it('forgets a removed workspace', () => {
    const storage = memoryStorage();
    recordRecentDocument('ws', 'a.md', storage);
    forgetRecentDocuments('ws', storage);
    expect(loadRecentDocuments('ws', storage)).to.deep.equal([]);
  });

  it('ignores corrupt or unexpected storage shapes', () => {
    expect(loadRecentDocuments('ws', memoryStorage('{not json'))).to.deep.equal([]);
    expect(
      parseRecentDocuments([
        { workspaceId: 'ws', paths: ['a.md', 7, '../escape.md', 'a.md'] },
        { workspaceId: 'ws2', paths: ['b.md'], extra: true },
        'nonsense',
      ]),
    ).to.deep.equal(new Map([['ws', ['a.md']]]));
  });

  it('survives unavailable storage', () => {
    expect(() => recordRecentDocument('ws', 'a.md', null)).to.not.throw();
    expect(loadRecentDocuments('ws', null)).to.deep.equal([]);
  });
});
