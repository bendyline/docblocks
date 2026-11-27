import { expect } from 'chai';
import { MemoryFileSystemProviderV2 } from '@bendyline/docblocks/filesystem/memory';
import { parseWorkspacePath, type FileSystemProvider } from '@bendyline/docblocks/filesystem';
import type { IndexedDocument } from '@bendyline/docblocks/workspace-index';
import {
  HOME_DIGEST_LIMITS,
  parseHomeDigest,
  projectHomeDigest,
  sameHomeDigest,
} from '../src/Home/home-digest.js';
import { digestWorkspaceOnce } from '../src/Home/useHomeDigests.js';
import { kindFoldersFromMarkers, taskItemsFromDocuments } from '../src/Tasks/task-model.js';

const p = parseWorkspacePath;
const encode = (text: string) => new TextEncoder().encode(text);

function doc(path: string, fields: Partial<IndexedDocument> = {}): IndexedDocument {
  return {
    path: p(path),
    sourcePath: p(path),
    format: 'markdown',
    lastModified: '2026-11-20T10:00:00.000Z',
    title: path,
    outline: [],
    wordCount: 1,
    content: 'full',
    ...fields,
  };
}

const markers = [
  {
    path: p('Tasks'),
    status: 'ok' as const,
    settings: { version: 1 as const, kind: 'tasks' as const },
    version: null,
  },
  {
    path: p('Inbox'),
    status: 'ok' as const,
    settings: { version: 1 as const, kind: 'unfiled' as const },
    version: null,
  },
];

describe('home digest', () => {
  const kindFolders = kindFoldersFromMarkers(markers);
  const documents = [
    doc('Tasks/Active/Call Priya.md', {
      due: '2026-11-24',
      category: 'Work',
      checklist: { done: 1, total: 2 },
    }),
    doc('Tasks/Done/Old.md', { completed: '2026-09-01' }),
    doc('Tasks/Done/Recent.md', { completed: '2026-11-20' }),
    doc('Clients/Proposal.md', { due: '2026-11-23T09:00', repeat: 'weekly' }),
    doc('Inbox/a.md'),
    doc('Inbox/b.pdf.md'),
    doc('Notes/plain.md'),
  ];
  const items = taskItemsFromDocuments('w1', documents, kindFolders);
  const digest = projectHomeDigest({
    workspaceId: 'w1',
    kindFolders,
    documents,
    items,
    today: '2026-11-23',
    now: new Date('2026-11-23T12:00:00Z'),
  });

  it('keeps open tasks, dated documents and recently finished tasks', () => {
    expect(digest.items.map((item) => item.path).sort()).to.deep.equal([
      'Clients/Proposal.md',
      'Tasks/Active/Call Priya.md',
      'Tasks/Done/Recent.md',
    ]);
    expect(digest.folders).to.deep.equal([
      { path: 'Tasks', kind: 'tasks' },
      { path: 'Inbox', kind: 'unfiled', waiting: 2 },
    ]);
    expect(digest.dropped).to.equal(0);
  });

  it('reads back exactly what it wrote, and nothing else', () => {
    const stored = JSON.parse(JSON.stringify(digest));
    expect(parseHomeDigest(stored, 'w1')).to.deep.equal(digest);
    expect(
      sameHomeDigest(parseHomeDigest(stored, 'w1'), { ...digest, madeAt: '2027-01-01T00:00:00Z' }),
    ).to.equal(true);
    for (const broken of [
      null,
      { ...stored, format: 2 },
      { ...stored, workspaceId: 'w2' },
      { ...stored, madeAt: 'yesterday' },
      { ...stored, items: [{ ...stored.items[0], due: 'soon' }] },
      { ...stored, items: [{ ...stored.items[0], repeat: 'hourly' }] },
      { ...stored, items: [{ ...stored.items[0], checklist: { done: 3, total: 2 } }] },
      { ...stored, folders: [{ path: 'X', kind: 'chats' }] },
      { ...stored, items: new Array(HOME_DIGEST_LIMITS.maxItems + 1).fill(stored.items[0]) },
    ]) {
      expect(parseHomeDigest(broken, 'w1')).to.equal(null);
    }
    // Checked against the workspace it is filed under.
    expect(parseHomeDigest(stored, 'other')).to.equal(null);
  });

  it('reads a workspace that is not open, once, and digests it', async () => {
    const v2 = new MemoryFileSystemProviderV2('digest-once', 'Digest');
    const files: Record<string, string> = {
      'Tasks/.docblocks/folder.json': '{"version":1,"kind":"tasks"}',
      'Tasks/Active/Book dentist.md': '---\ndue: 2026-11-27\n---\n',
      'Notes/a.md': '# A\n',
    };
    for (const [path, text] of Object.entries(files)) {
      await v2.writeFile(p(path), encode(text), { createParents: true });
    }
    const once = await digestWorkspaceOnce('w9', { v2 } as unknown as FileSystemProvider, {
      now: () => new Date('2026-11-23T12:00:00Z'),
    });
    expect(once?.workspaceId).to.equal('w9');
    expect(once?.items.map((item) => [item.path, item.due])).to.deep.equal([
      ['Tasks/Active/Book dentist.md', '2026-11-27'],
    ]);
    expect(once?.folders).to.deep.equal([{ path: 'Tasks', kind: 'tasks' }]);
  });

  it('gives up on a workspace that takes longer than its budget', async () => {
    const v2 = new MemoryFileSystemProviderV2('digest-slow', 'Slow');
    await v2.writeFile(p('a.md'), encode('# A\n'));
    const slow = {
      v2: {
        ...v2,
        capabilities: v2.capabilities,
        stat: (path: string) => v2.stat(path as never),
        readFile: (path: string) => v2.readFile(path as never),
        readDirectory: () => new Promise(() => undefined),
      },
    } as unknown as FileSystemProvider;
    expect(await digestWorkspaceOnce('slow', slow, { budgetMs: 50 })).to.equal(null);
  });
});
