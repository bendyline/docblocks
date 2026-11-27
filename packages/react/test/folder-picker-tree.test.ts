import { expect } from 'chai';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { treeKeyAction } from '../src/FileExplorer/tree-keyboard.js';
import {
  buildWorkspaceTree,
  describeChoice,
  folderKey,
  keysAbove,
  parseFolderKey,
  pickerRows,
  type FolderListing,
  type PickerWorkspace,
  type WorkspaceTree,
} from '../src/FolderPicker/folder-tree.js';
import { listProviderFolders } from '../src/FolderPicker/list-folders.js';

const HOME: PickerWorkspace = { id: 'home', name: 'Home' };
const WORK: PickerWorkspace = { id: 'work', name: 'Work' };

function ready(paths: readonly string[], partial = false): FolderListing {
  return { status: 'ready', folders: paths.map((path) => ({ path })), partial };
}

function rowsFor(listings: Record<string, FolderListing>, expanded: readonly string[], query = '') {
  const map = new Map(Object.entries(listings));
  const trees = new Map<string, WorkspaceTree>();
  for (const [id, listing] of map) {
    if (listing.status === 'ready') trees.set(id, buildWorkspaceTree(listing.folders));
  }
  return pickerRows({
    workspaces: [HOME, WORK],
    listings: map,
    trees,
    expanded: new Set(expanded),
    query,
  });
}

function labels(rows: ReturnType<typeof rowsFor>) {
  return rows.map((row) => `${'  '.repeat(row.depth)}${row.name}`);
}

describe('workspace folder picker tree', () => {
  it('indexes a flat folder list as a tree, filling in parents and sorting by name', () => {
    const tree = buildWorkspaceTree([
      { path: 'Projects/Ocean/Tides' },
      { path: 'Archive' },
      { path: 'Projects/Item 10' },
      { path: 'Projects/Item 9' },
      { path: 'Tasks', kind: 'tasks' },
    ]);
    expect(tree.children.get('')).to.eql(['Archive', 'Projects', 'Tasks']);
    expect(tree.children.get('Projects')).to.eql([
      'Projects/Item 9',
      'Projects/Item 10',
      'Projects/Ocean',
    ]);
    expect(tree.children.get('Projects/Ocean')).to.eql(['Projects/Ocean/Tides']);
    expect(tree.kinds.get('Tasks')).to.equal('tasks');
  });

  it('leaves out folders no document belongs in, and everything inside them', () => {
    const tree = buildWorkspaceTree([
      { path: 'Notes' },
      { path: 'Notes/Tides_files' },
      { path: 'indexing_files - Copy' },
      { path: 'indexing_files - Copy/Inner' },
      { path: 'posts' },
      { path: 'posts/_templates' },
      { path: '_squisq' },
      { path: '.git/refs' },
      { path: 'node_modules/chai' },
      { path: 'prompts_recurring' },
      { path: 'blog/_posts' },
    ]);
    expect(tree.children.get('')).to.eql(['blog', 'Notes', 'posts', 'prompts_recurring']);
    expect(tree.children.get('Notes')).to.equal(undefined);
    expect(tree.children.get('posts')).to.equal(undefined);
    // A static site's own underscore folders are real places for documents.
    expect(tree.children.get('blog')).to.eql(['blog/_posts']);
  });

  it('shows every workspace as a root and the open ones’ folders beneath', () => {
    const rows = rowsFor(
      { home: ready(['Notes', 'Notes/2026', 'Tasks']), work: ready(['Clients']) },
      [folderKey('home', ''), folderKey('home', 'Notes')],
    );
    expect(labels(rows)).to.eql(['Home', '  Notes', '    2026', '  Tasks', 'Work']);
    const [home, notes, year, tasks, work] = rows;
    expect(home!.isWorkspace).to.equal(true);
    expect(home!.expanded).to.equal(true);
    expect(notes!.parentPath).to.equal(folderKey('home', ''));
    expect(year!.parentPath).to.equal(folderKey('home', 'Notes'));
    expect(year!.empty).to.equal(true);
    expect([notes!.posInSet, notes!.setSize, tasks!.posInSet]).to.eql([1, 2, 2]);
    expect(work!.expanded).to.equal(false);
    expect([work!.posInSet, work!.setSize]).to.eql([2, 2]);
  });

  it('keeps the same folder in two workspaces apart', () => {
    const rows = rowsFor({ home: ready(['Notes']), work: ready(['Notes']) }, [
      folderKey('home', ''),
      folderKey('work', ''),
    ]);
    const notes = rows.filter((row) => row.name === 'Notes');
    expect(notes.map((row) => row.workspaceId)).to.eql(['home', 'work']);
    expect(new Set(notes.map((row) => row.path)).size).to.equal(2);
    expect(parseFolderKey(notes[1]!.path)).to.eql({ workspaceId: 'work', path: 'Notes' });
  });

  it('says when a workspace is being read, cannot be, or is only partly listed', () => {
    const loading = rowsFor({ home: { status: 'loading' } }, [folderKey('home', '')]);
    expect(loading[0]!.note).to.equal('Looking…');
    expect(loading[0]!.empty).to.equal(undefined);

    const unavailable = rowsFor(
      { home: { status: 'unavailable', message: 'Open it once, then its folders show here.' } },
      [folderKey('home', '')],
    );
    expect(unavailable[0]!.note).to.contain('Open it once');
    expect(unavailable[0]!.empty).to.equal(true);
    expect(unavailable[0]!.expanded).to.equal(false);

    const partial = rowsFor({ home: ready(['A'], true) }, []);
    expect(partial[0]!.note).to.equal('Not every folder is shown');
  });

  it('finds folders by name in every workspace, with their parents open', () => {
    const rows = rowsFor(
      {
        home: ready(['Notes', 'Notes/Ocean tides', 'Recipes']),
        work: ready(['Clients/Acme/Tide charts', 'Clients/Bolt']),
      },
      [],
      'tide',
    );
    expect(labels(rows)).to.eql([
      'Home',
      '  Notes',
      '    Ocean tides',
      'Work',
      '  Clients',
      '    Acme',
      '      Tide charts',
    ]);
    expect(rows[2]!.match).to.eql([[6, 10]]);
    expect(rows[1]!.match).to.eql([]);
  });

  it('keeps a workspace still being read while finding, and drops one with no match', () => {
    const rows = rowsFor({ home: ready(['Recipes']), work: { status: 'loading' } }, [], 'tide');
    expect(labels(rows)).to.eql(['Work']);
    expect(rows[0]!.note).to.equal('Looking…');
  });

  it('drives the file tree’s keyboard rules', () => {
    const rows = rowsFor({ home: ready(['Notes', 'Notes/2026']), work: ready([]) }, [
      folderKey('home', ''),
    ]);
    expect(treeKeyAction(rows, folderKey('home', 'Notes'), 'ArrowRight')).to.eql({
      type: 'expand',
      path: folderKey('home', 'Notes'),
    });
    expect(treeKeyAction(rows, folderKey('home', 'Notes'), 'ArrowLeft')).to.eql({
      type: 'focus',
      path: folderKey('home', ''),
    });
    expect(treeKeyAction(rows, folderKey('home', 'Notes'), 'ArrowDown')).to.eql({
      type: 'focus',
      path: folderKey('work', ''),
    });
    // A workspace with no folders is a leaf.
    expect(treeKeyAction(rows, folderKey('work', ''), 'ArrowRight')).to.eql({ type: 'none' });
  });

  it('names the keys above a folder and describes a choice', () => {
    expect(keysAbove('home', 'Notes/2026/Nov')).to.eql([
      folderKey('home', ''),
      folderKey('home', 'Notes/2026'),
      folderKey('home', 'Notes'),
    ]);
    expect(
      describeChoice({ workspaceId: 'w', workspaceName: 'Work', path: 'Clients/Acme' }),
    ).to.equal('Work › Clients › Acme');
    expect(describeChoice({ workspaceId: 'w', workspaceName: 'Work', path: '' })).to.equal('Work');
  });
});

describe('listProviderFolders', () => {
  async function workspace() {
    const fs = new MemoryFileSystemProvider('folders', 'Folders');
    await fs.writeFile('Notes/2026/Tides.md', '# Tides');
    await fs.writeBinary('Notes/2026/Tides_files/chart.png', new Uint8Array([1]));
    await fs.writeFile('Tasks/.docblocks/folder.json', '{}');
    await fs.writeFile('_squisq/player.js', '');
    await fs.writeFile('_templates/post.html', '');
    await fs.writeBinary('Notes/Tides_files - Copy/Inner/chart.png', new Uint8Array([1]));
    await fs.writeFile('.git/HEAD', '');
    await fs.v2.createDirectory(parseWorkspacePath('Empty'), { mode: 'ensure' });
    return fs;
  }

  it('lists every folder the tree shows, and nothing a person never sees', async () => {
    const fs = await workspace();
    const listed = await listProviderFolders(fs);
    expect([...listed.paths].sort()).to.eql(['Empty', 'Notes', 'Notes/2026', 'Tasks']);
    expect(listed.partial).to.equal(false);
  });

  it('stops at its limit and says the list is partial', async () => {
    const fs = await workspace();
    const listed = await listProviderFolders(fs, { limit: 2 });
    expect(listed.paths).to.have.length(2);
    expect(listed.partial).to.equal(true);
  });
});
