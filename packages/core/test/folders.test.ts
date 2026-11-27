import { expect } from 'chai';
import { FsError } from '../src/filesystem/fs-error.js';
import { MemoryFileSystemProviderV2 } from '../src/filesystem/memory-provider-v2.js';
import { WORKSPACE_ROOT, parseWorkspacePath } from '../src/filesystem/workspace-path.js';
import {
  FOLDER_SETTINGS_LIMITS,
  checkBucketName,
  completedTaskPath,
  defaultFolderSettings,
  findJournalEntry,
  folderOfSettingsPath,
  folderSettingsPath,
  isTaskDone,
  journalDateFromPath,
  journalEntryHeading,
  journalEntryMarkdown,
  journalEntryPath,
  kindFolderFor,
  kindFoldersOf,
  locateTask,
  newTaskPath,
  orderBuckets,
  parseFolderSettingsText,
  placeTask,
  readFolderSettings,
  removeFolderSettings,
  reopenedTaskPath,
  resolveTasksFolder,
  serializeFolderSettings,
  taskPathInBucket,
  writeFolderSettings,
  type FolderSettings,
  type KindFolder,
} from '../src/folders/index.js';

const p = parseWorkspacePath;
const encode = (text: string) => new TextEncoder().encode(text);

describe('folders: settings file', () => {
  it('lives in a .docblocks folder inside the folder it describes', () => {
    expect(folderSettingsPath(p('Tasks'))).to.equal('Tasks/.docblocks/folder.json');
    expect(folderSettingsPath(p('Work/Tasks'))).to.equal('Work/Tasks/.docblocks/folder.json');
    expect(folderSettingsPath(WORKSPACE_ROOT)).to.equal('.docblocks/folder.json');
    expect(folderOfSettingsPath('Work/Tasks/.docblocks/folder.json')).to.equal('Work/Tasks');
    expect(folderOfSettingsPath('.docblocks/folder.json')).to.equal('');
    expect(folderOfSettingsPath('.docblocks/workspace.json')).to.equal(null);
    expect(folderOfSettingsPath('Tasks/folder.json')).to.equal(null);
  });

  it('accepts the exact shape and writes it back in a stable order', () => {
    const parsed = parseFolderSettingsText(
      '{ "tasks": { "default": "Next", "done": ["Done", "Archive"] }, "kind": "tasks", "version": 1 }',
    );
    expect(parsed).to.deep.equal({
      status: 'ok',
      settings: {
        version: 1,
        kind: 'tasks',
        tasks: { done: ['Done', 'Archive'], default: 'Next' },
      },
    });
    expect(serializeFolderSettings((parsed as { settings: FolderSettings }).settings)).to.equal(
      [
        '{',
        '  "version": 1,',
        '  "kind": "tasks",',
        '  "tasks": {',
        '    "done": [',
        '      "Done",',
        '      "Archive"',
        '    ],',
        '    "default": "Next"',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(serializeFolderSettings(defaultFolderSettings('journal'))).to.equal(
      '{\n  "version": 1,\n  "kind": "journal"\n}\n',
    );
  });

  it('reports a newer version or an unknown kind as unsupported, not as broken', () => {
    expect(parseFolderSettingsText('{"version":2,"kind":"tasks","extra":true}').status).to.equal(
      'unsupported-version',
    );
    expect(parseFolderSettingsText('{"version":1,"kind":"recipes"}').status).to.equal(
      'unsupported-kind',
    );
    expect(parseFolderSettingsText('{"version":1,"kind":"chats"}').settings?.kind).to.equal(
      'chats',
    );
  });

  it('rejects anything else as invalid', () => {
    const invalid = [
      'not json',
      '[]',
      '{}',
      '{"version":1}',
      '{"version":"1","kind":"tasks"}',
      '{"version":1,"kind":"tasks","color":"red"}',
      '{"version":1,"kind":"journal","tasks":{"done":["Done"]}}',
      '{"version":1,"kind":"tasks","tasks":{"done":[]}}',
      '{"version":1,"kind":"tasks","tasks":{"done":["a/b"]}}',
      '{"version":1,"kind":"tasks","tasks":{"done":["Done","done"]}}',
      '{"version":1,"kind":"tasks","tasks":{"done":["Done"],"default":"done"}}',
      '{"version":1,"kind":"tasks","tasks":{"default":".hidden"}}',
      '{"version":1,"kind":"tasks","tasks":{"priority":1}}',
      `{"version":1,"kind":"tasks","$schema":"${'x'.repeat(FOLDER_SETTINGS_LIMITS.maxFileBytes)}"}`,
    ];
    for (const text of invalid) {
      expect(parseFolderSettingsText(text).status, text.slice(0, 60)).to.equal('invalid');
    }
  });

  it('checks bucket names', () => {
    expect(checkBucketName('Waiting')).to.equal(null);
    expect(checkBucketName('Next week')).to.equal(null);
    for (const bad of ['', '  ', ' x', 'a/b', 'a\\b', '.git', '..', 'x'.repeat(256), 7]) {
      expect(checkBucketName(bad), String(bad).slice(0, 12)).to.be.a('string');
    }
  });

  it('reads, writes over the version it saw, and removes', async () => {
    const provider = new MemoryFileSystemProviderV2('folders-store', 'Folders');
    await provider.writeFile(p('Tasks/Active/a.md'), encode('# A\n'), { createParents: true });
    const folder = p('Tasks');

    const missing = await readFolderSettings(provider, folder);
    expect(missing).to.include({ status: 'missing', settings: null, version: null });

    const written = await writeFolderSettings(
      provider,
      folder,
      missing,
      defaultFolderSettings('tasks'),
    );
    expect(written.status).to.equal('ready');
    const read = await readFolderSettings(provider, folder);
    expect(read.settings).to.deep.equal({ version: 1, kind: 'tasks' });
    expect(read.version).to.equal(written.version);

    // Someone else changed the file since `missing` was observed: creating again must fail.
    let conflict: unknown;
    try {
      await writeFolderSettings(provider, folder, missing, defaultFolderSettings('journal'));
    } catch (error: unknown) {
      conflict = error;
    }
    expect(conflict).to.be.instanceOf(FsError);

    const updated = await writeFolderSettings(provider, folder, read, {
      version: 1,
      kind: 'tasks',
      tasks: { done: ['Done', 'Archive'] },
    });
    expect((await readFolderSettings(provider, folder)).settings?.tasks?.done).to.deep.equal([
      'Done',
      'Archive',
    ]);

    await removeFolderSettings(provider, folder, updated);
    expect((await readFolderSettings(provider, folder)).status).to.equal('missing');
    expect(await provider.stat(p('Tasks/Active/a.md'))).to.not.equal(null);
    await provider.dispose();
  });

  it('never treats a file it cannot use as absent, and refuses to overwrite it', async () => {
    const provider = new MemoryFileSystemProviderV2('folders-bad', 'Folders');
    await provider.writeFile(p('A/.docblocks/folder.json'), encode('{"version":3,"kind":"x"}'), {
      createParents: true,
    });
    await provider.writeFile(p('B/.docblocks/folder.json'), encode('{oops'), {
      createParents: true,
    });
    const newer = await readFolderSettings(provider, p('A'));
    expect(newer).to.include({ status: 'unsupported-version', settings: null });
    expect(newer.version).to.not.equal(null);
    const broken = await readFolderSettings(provider, p('B'));
    expect(broken.status).to.equal('invalid');
    for (const state of [newer, broken]) {
      let refused: unknown;
      try {
        await writeFolderSettings(provider, p('A'), state, defaultFolderSettings('tasks'));
      } catch (error: unknown) {
        refused = error;
      }
      expect(refused).to.be.instanceOf(Error);
    }
    await provider.dispose();
  });
});

describe('folders: tasks', () => {
  const folder = resolveTasksFolder(p('Tasks'), {});

  it('fills in Active and Done when the settings name no buckets', () => {
    expect(folder).to.deep.equal({ path: 'Tasks', doneFolders: ['Done'], defaultFolder: 'Active' });
    expect(
      resolveTasksFolder(p('T'), { tasks: { done: ['Finished', 'Archive'], default: 'Next' } }),
    ).to.deep.equal({ path: 'T', doneFolders: ['Finished', 'Archive'], defaultFolder: 'Next' });
  });

  it("reads a task's bucket, group and state from its path", () => {
    expect(placeTask(folder, p('Tasks/Active/Paint.md'))).to.deep.equal({
      bucket: 'Active',
      group: '',
      name: 'Paint.md',
      done: false,
    });
    expect(placeTask(folder, p('Tasks/done/House/Kitchen/Paint.md'))).to.deep.equal({
      bucket: 'done',
      group: 'House/Kitchen',
      name: 'Paint.md',
      done: true,
    });
    expect(placeTask(folder, p('Tasks/Loose.md'))).to.deep.equal({
      bucket: null,
      group: '',
      name: 'Loose.md',
      done: false,
    });
    expect(placeTask(folder, p('Notes/Paint.md'))).to.equal(null);
    expect(placeTask(folder, p('Tasks'))).to.equal(null);
    expect(placeTask(folder, p('TasksOther/Active/x.md'))).to.equal(null);
    // Markdown inside a document's own media folder belongs to that document.
    expect(placeTask(folder, p('Tasks/Active/Paint_files/ai/quiz.md'))).to.equal(null);
  });

  it('finishes into Done and reopens into Active, keeping the folders below the bucket', () => {
    expect(completedTaskPath(folder, p('Tasks/Active/House/Paint.md'))).to.equal(
      'Tasks/Done/House/Paint.md',
    );
    expect(completedTaskPath(folder, p('Tasks/Someday/Paint.md'))).to.equal('Tasks/Done/Paint.md');
    expect(completedTaskPath(folder, p('Tasks/Loose.md'))).to.equal('Tasks/Done/Loose.md');
    expect(completedTaskPath(folder, p('Tasks/Done/Paint.md'))).to.equal('Tasks/Done/Paint.md');
    expect(reopenedTaskPath(folder, p('Tasks/Done/House/Paint.md'))).to.equal(
      'Tasks/Active/House/Paint.md',
    );
    expect(reopenedTaskPath(folder, p('Tasks/Waiting/Paint.md'))).to.equal(
      'Tasks/Waiting/Paint.md',
    );
    expect(() => completedTaskPath(folder, p('Notes/x.md'))).to.throw(RangeError);
  });

  it('moves between buckets, and into the tasks folder itself', () => {
    expect(taskPathInBucket(folder, p('Tasks/Active/House/Paint.md'), 'Waiting')).to.equal(
      'Tasks/Waiting/House/Paint.md',
    );
    expect(taskPathInBucket(folder, p('Tasks/Active/Paint.md'), 'active')).to.equal(
      'Tasks/Active/Paint.md',
    );
    expect(taskPathInBucket(folder, p('Tasks/Active/Paint.md'), null)).to.equal('Tasks/Paint.md');
    expect(newTaskPath(folder, 'Call Sam.md')).to.equal('Tasks/Active/Call Sam.md');
    expect(newTaskPath(folder, 'Call Sam.md', 'Waiting')).to.equal('Tasks/Waiting/Call Sam.md');
    expect(newTaskPath(folder, 'Call Sam.md', null)).to.equal('Tasks/Call Sam.md');
    expect(() => newTaskPath(folder, 'a/b.md')).to.throw(RangeError);
    const root = resolveTasksFolder(WORKSPACE_ROOT, {});
    expect(placeTask(root, p('Active/x.md'))?.bucket).to.equal('Active');
    expect(completedTaskPath(root, p('Active/x.md'))).to.equal('Done/x.md');
  });

  it('lets the folder decide whether a task is done, and frontmatter decide elsewhere', () => {
    const inDone = placeTask(folder, p('Tasks/Done/a.md'));
    const inActive = placeTask(folder, p('Tasks/Active/a.md'));
    expect(isTaskDone(inDone, {})).to.equal(true);
    // Dragged back out of Done in a file manager: open again, whatever the stamp says.
    expect(isTaskDone(inActive, { completed: '2026-11-20' })).to.equal(false);
    expect(isTaskDone(null, { completed: '2026-11-20' })).to.equal(true);
    expect(isTaskDone(null, { completed: true })).to.equal(true);
    expect(isTaskDone(null, {})).to.equal(false);
  });

  it('orders bucket columns: default first, done last, with the essentials always shown', () => {
    expect(
      orderBuckets(folder, ['Waiting', 'Done', 'Active', 'Paint_files', '.docblocks']),
    ).to.deep.equal([
      { name: 'Active', done: false, exists: true },
      { name: 'Waiting', done: false, exists: true },
      { name: 'Done', done: true, exists: true },
    ]);
    expect(orderBuckets(folder, [])).to.deep.equal([
      { name: 'Active', done: false, exists: false },
      { name: 'Done', done: true, exists: false },
    ]);
    expect(orderBuckets(folder, ['active', 'DONE']).map((bucket) => bucket.name)).to.deep.equal([
      'active',
      'DONE',
    ]);
  });
});

describe('folders: which kind folder a path is in', () => {
  const folders: KindFolder[] = [
    { path: p('Tasks'), settings: { version: 1, kind: 'tasks' } },
    { path: p('Tasks/Log'), settings: { version: 1, kind: 'journal' } },
    { path: p('Unfiled'), settings: { version: 1, kind: 'unfiled' } },
    {
      path: p('Work/Tasks'),
      settings: { version: 1, kind: 'tasks', tasks: { done: ['Shipped'] } },
    },
  ];

  it('picks the nearest kind folder above a path', () => {
    expect(kindFolderFor(folders, p('Tasks/Active/a.md'))?.path).to.equal('Tasks');
    expect(kindFolderFor(folders, p('Tasks/Log/2026/2026-11-23.md'))?.path).to.equal('Tasks/Log');
    expect(kindFolderFor(folders, p('Notes/a.md'))).to.equal(null);
    expect(kindFolderFor(folders, p('Tasks'))).to.equal(null);
    expect(kindFolderFor(folders, p('Tasks'), true)?.settings.kind).to.equal('tasks');
    expect(kindFoldersOf(folders, 'tasks').map((folder) => folder.path)).to.deep.equal([
      'Tasks',
      'Work/Tasks',
    ]);
  });

  it('locates a task only when its nearest kind folder is a tasks folder', () => {
    expect(locateTask(folders, p('Work/Tasks/Shipped/a.md'))).to.deep.include({
      placement: { bucket: 'Shipped', group: '', name: 'a.md', done: true },
    });
    expect(locateTask(folders, p('Tasks/Active/a.md'))?.folder.path).to.equal('Tasks');
    expect(locateTask(folders, p('Tasks/Log/2026/2026-11-23.md'))).to.equal(null);
    expect(locateTask(folders, p('Unfiled/note.md'))).to.equal(null);
    expect(locateTask(folders, p('Notes/a.md'))).to.equal(null);
  });
});

describe('folders: journal', () => {
  it('names an entry for its day, in a folder for its year', () => {
    expect(journalEntryPath(p('Journal'), '2026-11-23')).to.equal('Journal/2026/2026-11-23.md');
    expect(journalEntryPath(WORKSPACE_ROOT, '2027-01-01')).to.equal('2027/2027-01-01.md');
    expect(() => journalEntryPath(p('Journal'), '2026-02-30')).to.throw(RangeError);
  });

  it('reads the day back from a file name, wherever the file is', () => {
    expect(journalDateFromPath('Journal/2026/2026-11-23.md')).to.equal('2026-11-23');
    expect(journalDateFromPath('2026-11-23 Lisbon.MD')).to.equal('2026-11-23');
    expect(journalDateFromPath('Journal/2026-11-23-notes.markdown')).to.equal('2026-11-23');
    expect(journalDateFromPath('Journal/2026-02-30.md')).to.equal(null);
    expect(journalDateFromPath('Journal/November.md')).to.equal(null);
    expect(journalDateFromPath('Journal/2026-11-23.txt')).to.equal(null);
    expect(journalDateFromPath('Journal/2026-11-234.md')).to.equal(null);
  });

  it('finds the entry for a day even when it was filed somewhere else in the journal', () => {
    const paths = ['Journal/2026/2026-11-22.md', 'Journal/Trips/2026-11-23 Lisbon.md', 'x.md'];
    expect(findJournalEntry(p('Journal'), paths, '2026-11-23')).to.equal(
      'Journal/Trips/2026-11-23 Lisbon.md',
    );
    expect(
      findJournalEntry(p('Journal'), [...paths, 'Journal/2026/2026-11-23.md'], '2026-11-23'),
    ).to.equal('Journal/2026/2026-11-23.md');
    expect(findJournalEntry(p('Journal'), paths, '2026-11-24')).to.equal(null);
    expect(findJournalEntry(p('Journal'), ['Other/2026-11-23.md'], '2026-11-23')).to.equal(null);
  });

  it("heads a new entry with the long date, whatever the reader's time zone", () => {
    // Punctuation between the parts varies by ICU version; the words do not.
    expect(journalEntryHeading('2026-11-23', 'en-GB')).to.match(/^Monday,? 23 November 2026$/);
    expect(journalEntryHeading('2026-11-23', 'en-US')).to.equal('Monday, November 23, 2026');
    expect(journalEntryMarkdown('2026-01-01', 'en-US')).to.equal('# Thursday, January 1, 2026\n\n');
  });
});
