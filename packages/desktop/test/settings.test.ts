import { expect } from 'chai';
import path from 'node:path';
import { SETTINGS_MAX_BYTES, parseSettings } from '../main/settings-schema.js';
import {
  atomicWriteSettingsFile,
  readSettingsFile,
  readSettingsFileWithRecovery,
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

  it('retries a transient rename with the default delay', async () => {
    let renameAttempts = 0;
    await atomicWriteSettingsFile(
      settingsPath,
      '{}',
      fakeIo({
        rename: async () => {
          renameAttempts += 1;
          if (renameAttempts === 1) throw nodeError('EBUSY', 'busy');
        },
      }),
    );

    expect(renameAttempts).to.equal(2);
  });
});

describe('desktop settings recovery', () => {
  const settingsPath = path.resolve('settings.json');
  const clock = () => new Date('2026-07-15T09:30:00.000Z');
  const expectedQuarantine = `${settingsPath}.2026-07-15T09-30-00-000Z.corrupt`;
  const recoveryOptions = { now: clock, retryDelay: async () => undefined };

  const unusable: readonly (readonly [string, Uint8Array])[] = [
    ['malformed JSON', new TextEncoder().encode('{broken')],
    ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
    ['a schema-invalid document', new TextEncoder().encode('{"workspaces":[],"surprise":true}')],
    ['a document that is not an object', new TextEncoder().encode('"nope"')],
    ['an oversized file', new Uint8Array(SETTINGS_MAX_BYTES + 1)],
  ];

  for (const [label, bytes] of unusable) {
    it(`falls back to defaults and preserves the original for ${label}`, async () => {
      const renames: [string, string][] = [];
      const result = await readSettingsFileWithRecovery(
        settingsPath,
        fakeIo({
          readFile: async () => bytes,
          rename: async (source, destination) => {
            renames.push([source, destination]);
          },
        }),
        recoveryOptions,
      );

      // Null settings is the caller's cue to apply defaults — the launch lives.
      expect(result.settings).to.equal(null);
      expect(result.recovery?.kind).to.equal('unusable-content');
      expect(result.recovery?.reason).to.be.a('string');
      expect(result.recovery?.reason).to.have.length.greaterThan(0);
      // The original bytes are moved aside, never destroyed.
      expect(renames).to.deep.equal([[settingsPath, expectedQuarantine]]);
      expect(result.recovery?.quarantinePath).to.equal(expectedQuarantine);
      expect(result.recovery?.quarantineFailure).to.equal(undefined);
    });
  }

  it('leaves a merely unreadable file untouched rather than quarantining it', async () => {
    const renames: string[] = [];
    const result = await readSettingsFileWithRecovery(
      settingsPath,
      fakeIo({
        readFile: async () => Promise.reject(nodeError('EACCES', 'denied')),
        rename: async (source) => {
          renames.push(source);
        },
      }),
      recoveryOptions,
    );

    expect(result.settings).to.equal(null);
    expect(result.recovery?.kind).to.equal('unreadable');
    expect(result.recovery?.reason).to.include('denied');
    // A lock or permission fault says nothing about the content: moving the
    // file aside would turn a transient problem into permanent settings loss.
    expect(renames).to.deep.equal([]);
    expect(result.recovery?.quarantinePath).to.equal(undefined);
  });

  it('still yields defaults when the original cannot be moved aside', async () => {
    const result = await readSettingsFileWithRecovery(
      settingsPath,
      fakeIo({
        readFile: async () => new TextEncoder().encode('{broken'),
        rename: async () => Promise.reject(nodeError('EPERM', 'locked by another process')),
      }),
      recoveryOptions,
    );

    // Failing to preserve the file must not become the reason there is no window.
    expect(result.settings).to.equal(null);
    expect(result.recovery?.kind).to.equal('unusable-content');
    expect(result.recovery?.quarantinePath).to.equal(undefined);
    expect(result.recovery?.quarantineFailure).to.include('locked by another process');
  });

  it('retries a transient quarantine rename', async () => {
    let attempts = 0;
    const result = await readSettingsFileWithRecovery(
      settingsPath,
      fakeIo({
        readFile: async () => new TextEncoder().encode('{broken'),
        rename: async () => {
          attempts += 1;
          if (attempts < 3) throw nodeError('EBUSY', 'busy');
        },
      }),
      recoveryOptions,
    );

    expect(attempts).to.equal(3);
    expect(result.recovery?.quarantinePath).to.equal(expectedQuarantine);
  });

  it('reports absence and valid settings without any recovery', async () => {
    const missing = await readSettingsFileWithRecovery(
      settingsPath,
      fakeIo({ readFile: async () => Promise.reject(nodeError('ENOENT', 'missing')) }),
      recoveryOptions,
    );
    expect(missing).to.deep.equal({ settings: null });

    const valid = await readSettingsFileWithRecovery(settingsPath, fakeIo({}), recoveryOptions);
    expect(valid).to.deep.equal({ settings: { workspaces: [] } });
  });

  it('timestamps each quarantine so a later corruption cannot overwrite an earlier one', async () => {
    const destinations: string[] = [];
    const io = fakeIo({
      readFile: async () => new TextEncoder().encode('{broken'),
      rename: async (_source, destination) => {
        destinations.push(destination);
      },
    });

    await readSettingsFileWithRecovery(settingsPath, io, { now: clock });
    await readSettingsFileWithRecovery(settingsPath, io, {
      now: () => new Date('2026-08-01T12:00:00.000Z'),
    });

    expect(destinations).to.deep.equal([
      expectedQuarantine,
      `${settingsPath}.2026-08-01T12-00-00-000Z.corrupt`,
    ]);
  });

  it('does not block the next write from re-creating settings.json', async () => {
    const files = new Map<string, string>([[settingsPath, '{broken']]);
    const io: SettingsFileIo = {
      readFile: async (file) => {
        const contents = files.get(file);
        if (contents === undefined) throw nodeError('ENOENT', 'missing');
        return new TextEncoder().encode(contents);
      },
      mkdir: async () => undefined,
      writeFile: async (file, contents) => {
        files.set(file, contents);
      },
      rename: async (source, destination) => {
        const contents = files.get(source);
        if (contents === undefined) throw nodeError('ENOENT', 'missing');
        files.delete(source);
        files.set(destination, contents);
      },
    };

    const recovered = await readSettingsFileWithRecovery(settingsPath, io, recoveryOptions);
    expect(recovered.settings).to.equal(null);

    await atomicWriteSettingsFile(settingsPath, '{"workspaces":[]}', io, {
      retryDelay: async () => undefined,
    });

    // The rewritten file is readable, and the corrupt original survives beside it.
    expect(await readSettingsFile(settingsPath, io)).to.deep.equal({ workspaces: [] });
    expect(files.get(expectedQuarantine)).to.equal('{broken');
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
