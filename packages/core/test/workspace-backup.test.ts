import { expect } from 'chai';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { MemoryFileSystemProviderV2 } from '../src/filesystem/memory-provider-v2.js';
import { parseWorkspacePath } from '../src/filesystem/workspace-path.js';
import {
  appendWorkspaceBackup,
  finishWorkspaceBackup,
  parseWorkspaceBackupManifest,
  readWorkspaceBackup,
  restoreWorkspaceBackup,
  WORKSPACE_BACKUP_MANIFEST,
} from '../src/workspace/backup.js';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('workspace backup restoration', () => {
  it('round-trips multiple same-named workspaces, binary assets, history and empty folders', async () => {
    const source = new MemoryFileSystemProviderV2('source', '日本語');
    const other = new MemoryFileSystemProviderV2('other', '日本語');
    const files = new Map([
      ['Notes.md', bytes('# Notes\n\n![photo](Notes_files/photo.png)')],
      ['Notes_files/photo.png', new Uint8Array([0, 255, 128, 42])],
      ['Notes_files/.gitignore', bytes('cache/')],
      ['.versions/Notes.md/1.md', bytes('Original revision')],
      ['.docblocks/workspace.json', bytes('{"name":"日本語"}')],
    ]);
    for (const [path, data] of files)
      await source.writeFile(parseWorkspacePath(path), data, { createParents: true });
    await source.createDirectory(parseWorkspacePath('empty/nested'), { createParents: true });
    await other.writeFile(parseWorkspacePath('Notes.md'), bytes('Other workspace'));
    const container = new MemoryContentContainer();
    const first = await appendWorkspaceBackup(container, source, []);
    const all = await appendWorkspaceBackup(container, other, first);
    await finishWorkspaceBackup(container, all);
    const restored = await readWorkspaceBackup(container, 'ignored');
    expect(restored.map((workspace) => workspace.name)).to.deep.equal(['日本語', '日本語']);
    const destination = new MemoryFileSystemProviderV2('restored', 'Restored');
    await restoreWorkspaceBackup(restored[0], destination);
    for (const [path, data] of files) {
      expect(
        new Uint8Array((await destination.readFile(parseWorkspacePath(path)))!.data),
      ).to.deep.equal(data);
    }
    expect((await destination.stat(parseWorkspacePath('empty/nested')))?.kind).to.equal(
      'directory',
    );
    expect(new TextDecoder().decode(restored[1].files[0].data)).to.equal('Other workspace');
  });

  it('accepts old plain ZIP contents without imposing the DBK Markdown-only contract', async () => {
    const container = new MemoryContentContainer();
    await container.writeFile('Welcome.md', bytes('# Hello'));
    await container.writeFile('Welcome_files/.gitignore', bytes('cache/'));
    await container.writeFile('Welcome_files/photo.png', new Uint8Array([0, 255]));
    const [workspace] = await readWorkspaceBackup(container, 'My Documents');
    expect(workspace.name).to.equal('My Documents');
    expect(workspace.files.map((file) => file.path).sort()).to.deep.equal([
      'Welcome.md',
      'Welcome_files/.gitignore',
      'Welcome_files/photo.png',
    ]);
  });

  it('refuses to restore over any existing document', async () => {
    const destination = new MemoryFileSystemProviderV2('existing', 'Existing');
    await destination.writeFile(parseWorkspacePath('note.md'), bytes('Keep me'));
    let failure: unknown;
    try {
      await restoreWorkspaceBackup(
        {
          name: 'Backup',
          directories: [],
          files: [{ path: parseWorkspacePath('note.md'), data: bytes('Replace me').buffer }],
        },
        destination,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect(
      new TextDecoder().decode((await destination.readFile(parseWorkspacePath('note.md')))!.data),
    ).to.equal('Keep me');
  });

  it('rejects unknown versions, traversal, alias paths, duplicate directories and unknown fields', () => {
    const manifest = {
      format: 'docblocks-workspace-backup',
      version: 1,
      workspaces: [{ name: 'Notes', prefix: 'workspaces/1', directories: [] }],
    };
    for (const invalid of [
      { ...manifest, version: 2 },
      { ...manifest, extra: true },
      ...[['../escape'], ['/absolute'], ['a\\b'], ['same', 'same'], [7]].map((directories) => ({
        ...manifest,
        workspaces: [{ ...manifest.workspaces[0], directories }],
      })),
    ])
      expect(() => parseWorkspaceBackupManifest(invalid)).to.throw();
  });

  it('rejects conflicting trees and unexpected archive members before restoring', async () => {
    for (const invalidPath of ['elsewhere.md', 'workspaces/1/a/b.md']) {
      const container = new MemoryContentContainer();
      await container.writeFile(
        WORKSPACE_BACKUP_MANIFEST,
        bytes(
          JSON.stringify({
            format: 'docblocks-workspace-backup',
            version: 1,
            workspaces: [{ name: 'Notes', prefix: 'workspaces/1', directories: [] }],
          }),
        ),
      );
      await container.writeFile('workspaces/1/a', bytes('file'));
      await container.writeFile(invalidPath, bytes('invalid'));
      let failure: unknown;
      try {
        await readWorkspaceBackup(container, 'ignored');
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
    }
  });
});
