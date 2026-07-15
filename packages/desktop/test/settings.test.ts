import { expect } from 'chai';
import path from 'node:path';
import { SETTINGS_MAX_BYTES, parseSettings } from '../main/settings-schema.js';
import {
  atomicWriteSettingsFile,
  readSettingsFile,
  type SettingsFileIo,
} from '../main/settings-file.js';
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

describe('desktop settings file I/O', () => {
  const settingsPath = path.resolve('settings.json');

  it('distinguishes absence from malformed, oversized, and inaccessible settings', async () => {
    const missing = nodeError('ENOENT', 'missing');
    expect(
      await readSettingsFile(
        settingsPath,
        fakeIo({ readFile: async () => Promise.reject(missing) }),
      ),
    ).to.equal(null);

    const malformed = await captureFailure(
      readSettingsFile(
        settingsPath,
        fakeIo({ readFile: async () => new TextEncoder().encode('{broken') }),
      ),
    );
    expect(malformed).to.be.instanceOf(SyntaxError);

    const oversized = await captureFailure(
      readSettingsFile(
        settingsPath,
        fakeIo({ readFile: async () => new Uint8Array(SETTINGS_MAX_BYTES + 1) }),
      ),
    );
    expect((oversized as Error).message).to.include('exceed');

    const denied = nodeError('EACCES', 'denied');
    expect(
      await captureFailure(
        readSettingsFile(settingsPath, fakeIo({ readFile: async () => Promise.reject(denied) })),
      ),
    ).to.equal(denied);
  });

  it('retries transient rename failures but not disk-full or permanent failures', async () => {
    let renameAttempts = 0;
    const transientIo = fakeIo({
      rename: async () => {
        renameAttempts += 1;
        if (renameAttempts < 3) throw nodeError('EPERM', 'busy');
      },
    });
    await atomicWriteSettingsFile(settingsPath, '{}', transientIo, {
      retryDelay: async () => undefined,
    });
    expect(renameAttempts).to.equal(3);

    renameAttempts = 0;
    const permanent = nodeError('EIO', 'device failure');
    const permanentFailure = await captureFailure(
      atomicWriteSettingsFile(
        settingsPath,
        '{}',
        fakeIo({
          rename: async () => {
            renameAttempts += 1;
            throw permanent;
          },
        }),
        { retryDelay: async () => undefined },
      ),
    );
    expect(permanentFailure).to.equal(permanent);
    expect(renameAttempts).to.equal(1);

    let writes = 0;
    const diskFull = nodeError('ENOSPC', 'disk full');
    const diskFullFailure = await captureFailure(
      atomicWriteSettingsFile(
        settingsPath,
        '{}',
        fakeIo({
          writeFile: async () => {
            writes += 1;
            throw diskFull;
          },
        }),
      ),
    );
    expect(diskFullFailure).to.equal(diskFull);
    expect(writes).to.equal(1);
  });
});

function fakeIo(overrides: Partial<SettingsFileIo>): SettingsFileIo {
  return {
    readFile: async () => new TextEncoder().encode('{"workspaces":[]}'),
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    rename: async () => undefined,
    ...overrides,
  };
}

function nodeError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
}
