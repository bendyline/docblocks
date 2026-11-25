import { expect } from 'chai';
import { MemoryFileSystemProviderV2 } from '@bendyline/docblocks/filesystem/memory';
import { parseWorkspacePath, type FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { readFolderSettings, type KindFolder } from '@bendyline/docblocks/folders';
import { parseWorkspacePassageUri, type AiChatKnowledge } from '@bendyline/docblocks/host';
import { chatTurnsFromMarkdown, saveChatTurn, type ChatStore } from '../src/Ai/ask-chats.js';
import { chatDocumentPaths, listChats } from '../src/Ai/chat-folders.js';
import { createProviderTaskGateway } from '../src/Tasks/task-operations.js';
import { workspaceCatalogId } from '../src/Ai/workspace-grounding.js';
import type { AskTurn } from '../src/Ai/workspace-ask.js';

const p = parseWorkspacePath;
let sequence = 0;

async function workspace(files: Record<string, string> = {}) {
  const v2 = new MemoryFileSystemProviderV2(`chats-${++sequence}`, 'Chats');
  for (const [path, text] of Object.entries(files)) {
    await v2.writeFile(p(path), new TextEncoder().encode(text), { createParents: true });
  }
  const provider = { v2 } as unknown as FileSystemProvider;
  const store: ChatStore = {
    gateway: createProviderTaskGateway(provider),
    storage: v2,
    kindFolders: [],
  };
  const read = async (path: string) => {
    const file = await v2.readFile(p(path));
    return file ? new TextDecoder().decode(file.data) : null;
  };
  return { v2, store, read };
}

const used: AiChatKnowledge = {
  outcome: 'used',
  sources: [
    { catalogId: 'workspace', name: 'This workspace', titles: ['Rose bed'] },
    { catalogId: 'pnw', name: 'Pacific Northwest', titles: ['Aphid'] },
  ],
  evidence: [
    {
      title: 'Rose bed',
      catalogId: 'workspace',
      text: 'Aphids in May.',
      uri: 'knowledge://local/ws-x/garden/rose%20bed.md#line=3-9',
    },
    { title: 'Aphid', catalogId: 'pnw', text: 'Aphids are insects.' },
  ],
};

const turn = (overrides: Partial<AskTurn>): AskTurn => ({
  id: 1,
  question: 'When do aphids come?',
  answer: 'In May [1].',
  status: 'done',
  knowledge: null,
  facts: null,
  error: null,
  truncated: false,
  ...overrides,
});

describe('Ask chats saved as Markdown', () => {
  it('sets up a chats folder on the first answer and names the chat for its question', async () => {
    const { v2, store, read } = await workspace();
    const path = await saveChatTurn(store, null, turn({ question: 'hi', answer: 'Hello!' }));
    expect(path).to.equal('Chats/hi.md');
    expect(await read(path)).to.equal('## You\n\nhi\n\n## AI\n\nHello!\n');
    const settings = await readFolderSettings(v2, p('Chats'));
    expect(settings.settings?.kind).to.equal('chats');
  });

  it('leaves a folder of the same name alone and uses the next one', async () => {
    const { store } = await workspace({ 'Chats/mine.md': '# Mine\n' });
    expect(await saveChatTurn(store, null, turn({ question: 'hi', answer: 'Hello!' }))).to.equal(
      'Chats 2/hi.md',
    );
  });

  it('appends each exchange with linked footnotes, keeping what the person added', async () => {
    const { store, read } = await workspace();
    const first = await saveChatTurn(store, null, turn({ knowledge: used, answer: 'In May [1].' }));
    await store.gateway.rewrite(first, async (source) => `${source}\nMy own aside.\n`);
    const again = await saveChatTurn(
      store,
      first,
      turn({
        question: 'Are they insects?',
        answer: 'Yes [2], in your roses too [1].',
        knowledge: used,
      }),
    );
    expect(again).to.equal(first);
    const text = await read(first);
    expect(text).to.contain('My own aside.');
    // Labels never repeat within the file, and the note links relative to the chat.
    expect(text).to.contain(
      '[^source-1]: [Rose bed](../garden/rose%20bed.md), a note in this workspace.',
    );
    expect(text).to.contain('[^source-2]: Aphid, from the Pacific Northwest knowledge catalog.');
    expect(text).to.contain(
      '[^source-3]: [Rose bed](../garden/rose%20bed.md), a note in this workspace.',
    );

    // Read back: citations again, opening the same note.
    const turns = chatTurnsFromMarkdown(text!, first, 'w1')!;
    expect(turns.map((entry) => [entry.question, entry.answer])).to.deep.equal([
      // What the person wrote under an answer reads as part of it.
      ['When do aphids come?', 'In May [1].\n\nMy own aside.'],
      ['Are they insects?', 'Yes [1], in your roses too [2].'],
    ]);
    const evidence = turns[1]!.knowledge?.outcome === 'used' ? turns[1]!.knowledge.evidence : [];
    expect(evidence.map((entry) => entry.title)).to.deep.equal(['Aphid', 'Rose bed']);
    const note = parseWorkspacePassageUri(evidence[1]!.uri!);
    expect(note).to.deep.include({
      catalogId: workspaceCatalogId('w1'),
      path: 'garden/rose bed.md',
    });
    expect(turns[1]!.knowledge?.outcome === 'used' && turns[1]!.knowledge.sources).to.deep.equal([
      // A file keeps a catalog's name, not its id.
      { catalogId: 'Pacific Northwest', name: 'Pacific Northwest', titles: ['Aphid'] },
      { catalogId: 'workspace', name: 'This workspace', titles: ['Rose bed'] },
    ]);
  });

  it('starts a new chat when the one it was saving to is gone', async () => {
    const { store } = await workspace();
    const path = await saveChatTurn(store, 'Chats/Deleted.md', turn({ question: 'Again?' }));
    expect(path).to.equal('Chats/Again.md');
  });

  it('is not a chat to continue when the file holds no conversation', () => {
    expect(chatTurnsFromMarkdown('# Notes\n\nPlain.', 'Chats/Notes.md', 'w1')).to.equal(null);
  });

  it('lists chats newest first and leaves them out of AI passages', () => {
    const chats: KindFolder = {
      path: p('Chats'),
      settings: { version: 1, kind: 'chats' },
    } as KindFolder;
    const documents = [
      { path: p('Chats/Old.md'), lastModified: '2026-11-20T00:00:00.000Z' },
      { path: p('Chats/New.md'), lastModified: '2026-11-24T00:00:00.000Z' },
      { path: p('Notes/Chats.md'), lastModified: '2026-11-24T00:00:00.000Z' },
    ];
    expect(listChats(documents, [chats]).map((chat) => chat.title)).to.deep.equal(['New', 'Old']);
    expect([...chatDocumentPaths(documents, [chats])].sort()).to.deep.equal([
      'Chats/New.md',
      'Chats/Old.md',
    ]);
    expect(listChats(documents, [])).to.deep.equal([]);
  });
});
