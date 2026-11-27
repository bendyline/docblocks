import { expect } from 'chai';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import {
  chooseUnfiledDrawer,
  declineInboxIds,
  fileIncomingDocument,
  isPhoneInboxPath,
  listPhoneInbox,
  loadDeclinedInboxIds,
} from '../src/DocBlocksShell/incoming-share.js';

const ID = '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const MARKER = '{"version":1,"kind":"unfiled"}';

function device(files: Record<string, string>): MemoryFileSystemProvider {
  const provider = new MemoryFileSystemProvider('local', 'On this device');
  for (const [path, text] of Object.entries(files)) provider.seedText(path, text);
  return provider;
}

describe('Phone shares into the Unfiled drawer', () => {
  it('recognises only what native intake writes to the device Inbox', () => {
    expect(isPhoneInboxPath('local', `/Inbox/${ID}/Garden.md`)).to.equal(true);
    expect(isPhoneInboxPath('local', `Inbox/${ID}/Garden.md`)).to.equal(true);
    expect(isPhoneInboxPath('icloud', `/Inbox/${ID}/Garden.md`)).to.equal(false);
    expect(isPhoneInboxPath('local', '/Inbox/Garden.md')).to.equal(false);
    expect(isPhoneInboxPath('local', `/Inbox/${ID}/Sub/Garden.md`)).to.equal(false);
    expect(isPhoneInboxPath('local', `/Notes/${ID}/Garden.md`)).to.equal(false);
  });

  it('files the document into the drawer and removes the Inbox copy', async () => {
    const source = device({
      [`Inbox/${ID}/Raised beds.md`]: '# Raised beds\n\n<https://example.com>\n',
    });
    const target = device({ 'Unfiled/.docblocks/folder.json': MARKER });
    const path = await fileIncomingDocument({
      source,
      path: `/Inbox/${ID}/Raised beds.md`,
      target,
      folder: 'Unfiled',
    });
    expect(path).to.equal('Unfiled/Raised beds.md');
    expect(await target.readFile('Unfiled/Raised beds.md')).to.equal(
      '# Raised beds\n\n<https://example.com>\n',
    );
    expect(await source.exists(`Inbox/${ID}`)).to.equal(false);
  });

  it('never replaces a document already in the drawer', async () => {
    const source = device({ [`Inbox/${ID}/Plan.md`]: 'new' });
    const target = device({ 'Unfiled/.docblocks/folder.json': MARKER, 'Unfiled/Plan.md': 'old' });
    const path = await fileIncomingDocument({
      source,
      path: `/Inbox/${ID}/Plan.md`,
      target,
      folder: '/Unfiled/',
    });
    expect(path).to.equal('Unfiled/Plan (2).md');
    expect(await target.readFile('Unfiled/Plan.md')).to.equal('old');
    expect(await target.readFile('Unfiled/Plan (2).md')).to.equal('new');
  });

  it('leaves the document in the Inbox when the drawer is no longer marked', async () => {
    const source = device({ [`Inbox/${ID}/Plan.md`]: 'text' });
    const target = device({ 'Unfiled/Other.md': 'x' });
    expect(
      await fileIncomingDocument({
        source,
        path: `/Inbox/${ID}/Plan.md`,
        target,
        folder: 'Unfiled',
      }),
    ).to.equal(null);
    expect(await source.readFile(`Inbox/${ID}/Plan.md`)).to.equal('text');
    expect(await target.exists('Unfiled/Plan.md')).to.equal(false);
  });

  it('keeps the Inbox copy when the drawer cannot take it', async () => {
    const source = device({ [`Inbox/${ID}/Plan.md`]: 'text' });
    const target = device({ 'Unfiled/.docblocks/folder.json': MARKER });
    // Imports write through the v2 surface.
    target.v2.writeFile = async () => {
      throw new Error('The disk is full.');
    };
    expect(
      await fileIncomingDocument({
        source,
        path: `/Inbox/${ID}/Plan.md`,
        target,
        folder: 'Unfiled',
      }),
    ).to.equal(null);
    expect(await source.readFile(`Inbox/${ID}/Plan.md`)).to.equal('text');
  });

  it('files into a drawer at the workspace root', async () => {
    const source = device({ [`Inbox/${ID}/Plan.md`]: 'text' });
    const target = device({ '.docblocks/folder.json': MARKER });
    expect(
      await fileIncomingDocument({ source, path: `/Inbox/${ID}/Plan.md`, target, folder: '' }),
    ).to.equal('Plan.md');
  });
});

describe('Which Unfiled drawer a phone share goes to', () => {
  const drawers = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("prefers the open workspace's drawer, live or saved", () => {
    expect(
      chooseUnfiledDrawer({
        openWorkspaceId: 'home',
        openDrawer: 'Inbox notes',
        savedDrawers: drawers({ home: 'Unfiled', work: 'Unfiled' }),
      }),
    ).to.deep.equal({ workspaceId: 'home', folder: 'Inbox notes' });
    // Before the open workspace's index has looked, its digest says where.
    expect(
      chooseUnfiledDrawer({
        openWorkspaceId: 'home',
        openDrawer: undefined,
        savedDrawers: drawers({ home: 'Unfiled', work: 'Unfiled' }),
      }),
    ).to.deep.equal({ workspaceId: 'home', folder: 'Unfiled' });
  });

  it('uses the only drawer elsewhere when the open workspace has none', () => {
    expect(
      chooseUnfiledDrawer({
        openWorkspaceId: 'local',
        openDrawer: undefined,
        savedDrawers: drawers({ work: 'Loose/Unfiled' }),
      }),
    ).to.deep.equal({ workspaceId: 'work', folder: 'Loose/Unfiled' });
    expect(
      chooseUnfiledDrawer({
        openWorkspaceId: null,
        openDrawer: undefined,
        savedDrawers: drawers({ work: '' }),
      }),
    ).to.deep.equal({ workspaceId: 'work', folder: '' });
  });

  it('leaves the choice between two drawers elsewhere to the person', () => {
    expect(
      chooseUnfiledDrawer({
        openWorkspaceId: 'local',
        openDrawer: undefined,
        savedDrawers: drawers({ home: 'Unfiled', work: 'Unfiled' }),
      }),
    ).to.equal(null);
    expect(
      chooseUnfiledDrawer({
        openWorkspaceId: 'local',
        openDrawer: undefined,
        savedDrawers: drawers({}),
      }),
    ).to.equal(null);
  });
});

describe("What waits in the phone's Inbox", () => {
  const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

  it('lists one document per share folder and skips anything else', async () => {
    const source = device({
      [`Inbox/${ID}/Raised beds.md`]: 'a',
      [`Inbox/${OTHER}/Receipt.pdf`]: 'b',
      'Inbox/not-a-share/Stray.md': 'c',
      'Inbox/Loose.md': 'd',
      'Notes/Elsewhere.md': 'e',
    });
    const items = await listPhoneInbox(source);
    expect(items.map((item) => item.path).sort()).to.deep.equal(
      [`Inbox/${ID}/Raised beds.md`, `Inbox/${OTHER}/Receipt.pdf`].sort(),
    );
    expect(items.find((item) => item.id === ID)?.name).to.equal('Raised beds.md');
    expect(await listPhoneInbox(source, 1)).to.have.length(1);
  });

  it('is empty when the device has no Inbox', async () => {
    expect(await listPhoneInbox(device({ 'Notes/A.md': 'a' }))).to.deep.equal([]);
  });

  it('files every listed document through the same import as a share', async () => {
    const source = device({
      [`Inbox/${ID}/Raised beds.md`]: 'a',
      [`Inbox/${OTHER}/Seeds.md`]: 'b',
    });
    const target = device({ 'Unfiled/.docblocks/folder.json': MARKER });
    for (const item of await listPhoneInbox(source)) {
      expect(
        await fileIncomingDocument({ source, path: item.path, target, folder: 'Unfiled' }),
      ).to.be.a('string');
    }
    expect(await listPhoneInbox(source)).to.deep.equal([]);
    expect(await target.readFile('Unfiled/Seeds.md')).to.equal('b');
  });

  it('remembers what was offered and left, on this device', () => {
    const storage = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      },
    });
    try {
      expect([...loadDeclinedInboxIds()]).to.deep.equal([]);
      declineInboxIds([ID]);
      declineInboxIds([ID, OTHER, 'not-an-id']);
      expect([...loadDeclinedInboxIds()].sort()).to.deep.equal([ID, OTHER].sort());
      storage.set('docblocks.phoneInbox.declined', '{broken');
      expect([...loadDeclinedInboxIds()]).to.deep.equal([]);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
