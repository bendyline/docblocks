import { expect } from 'chai';
import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import {
  createNativeFileActions,
  type NativeFileActionHost,
} from '../src/DocBlocksShell/native-file-actions.js';

const FILE: FileSystemEntry = { kind: 'file', name: 'draft.md', path: '/notes/draft.md' };
const DIRECTORY: FileSystemEntry = { kind: 'directory', name: 'notes', path: '/notes' };

describe('native file actions', () => {
  it('reveals and copies a file through main-owned workspace capabilities', async () => {
    const calls: string[] = [];
    const host: NativeFileActionHost = {
      shell: {
        revealInFolder: async (workspaceId, workspacePath) => {
          calls.push(`reveal:${workspaceId}:${workspacePath ?? ''}`);
        },
      },
      clipboard: {
        writeWorkspacePath: async (workspaceId, workspacePath) => {
          calls.push(`copy:${workspaceId}:${workspacePath}`);
        },
      },
    };

    const actions = createNativeFileActions(FILE, 'workspace-1', host);
    expect(actions.map((action) => action.label)).to.deep.equal([
      'Open containing folder',
      'Copy full path',
    ]);

    await actions[0]?.onSelect();
    await actions[1]?.onSelect();
    expect(calls).to.deep.equal([
      'reveal:workspace-1:/notes/draft.md',
      'copy:workspace-1:/notes/draft.md',
    ]);
  });

  it('omits native actions for directories and non-native workspaces', () => {
    const host = {
      shell: { revealInFolder: async () => undefined },
      clipboard: { writeWorkspacePath: async () => undefined },
    } satisfies NativeFileActionHost;

    expect(createNativeFileActions(DIRECTORY, 'workspace-1', host)).to.deep.equal([]);
    expect(createNativeFileActions(FILE, null, host)).to.deep.equal([]);
    expect(createNativeFileActions(FILE, 'workspace-1', null)).to.deep.equal([]);
  });
});
