import { expect } from 'chai';
import path from 'node:path';
import { parseSettings } from '../main/settings-schema.js';
import { SettingsWriteQueue } from '../main/settings-write-queue.js';

describe('desktop settings boundary', () => {
  const rootPath = path.resolve('workspace');
  const exportPath = path.resolve('exports', 'document.pdf');

  it('accepts the exact persisted shape', () => {
    expect(
      parseSettings({
        workspaces: [{ id: 'workspace-1', name: 'Workspace', rootPath }],
        iCloudPromptShown: true,
        exportTargets: {
          document: {
            last: { path: exportPath, confirmedByPicker: true },
            byExtension: { pdf: { path: exportPath, confirmedByPicker: true } },
          },
        },
      }),
    ).to.deep.equal({
      workspaces: [{ id: 'workspace-1', name: 'Workspace', rootPath }],
      iCloudPromptShown: true,
      exportTargets: {
        document: {
          last: { path: exportPath, confirmedByPicker: true },
          byExtension: { pdf: { path: exportPath, confirmedByPicker: true } },
        },
      },
    });
  });

  for (const [label, value] of [
    ['unknown root field', { workspaces: [], surprise: true }],
    ['missing workspaces', {}],
    [
      'relative workspace root',
      { workspaces: [{ id: 'workspace-1', name: 'Workspace', rootPath: 'relative' }] },
    ],
    [
      'duplicate workspace IDs',
      {
        workspaces: [
          { id: 'duplicate', name: 'First', rootPath },
          { id: 'duplicate', name: 'Second', rootPath: path.resolve('other') },
        ],
      },
    ],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => parseSettings(value)).to.throw(/Invalid desktop settings/u);
    });
  }
});

describe('SettingsWriteQueue', () => {
  it('continues serially after a failed write', async () => {
    const writes: number[] = [];
    const queue = new SettingsWriteQueue<number>(async (snapshot) => {
      writes.push(snapshot);
      if (snapshot === 1) throw new Error('disk unavailable');
    });

    let firstFailure: unknown;
    try {
      await queue.enqueue(1);
    } catch (error: unknown) {
      firstFailure = error;
    }
    expect(firstFailure).to.be.instanceOf(Error);

    await queue.enqueue(2);
    await queue.drain();
    expect(writes).to.deep.equal([1, 2]);
  });
});
