import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import {
  parseExtensionToWebviewMessage,
  parseWebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import {
  FsError,
  parseFileSystemVersion,
  parseWorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  WORKSPACE_SETTINGS_JSON_SCHEMA,
  refreshWorkspaceOutputs,
} from '@bendyline/docblocks/workspace-settings';
import {
  installVscodeStub,
  uninstallVscodeStub,
  FakeFileSystemError,
  FakeUri,
} from './helpers/vscodeStub.js';

/**
 * Workspace settings in the VS Code extension host: the webview protocol for
 * `.docblocks/workspace.json`, the `vscode.workspace.fs` adapter that core's
 * catalog generator writes through, and the JSON Schema VS Code validates the
 * file against.
 */

type IOModule = typeof import('../src/workspaceOutputsIO.js');
let ioModule: IOModule;

before(async () => {
  installVscodeStub();
  ioModule = (await import('../src/workspaceOutputsIO.js')) as IOModule;
});

after(() => {
  uninstallVscodeStub();
});

const FILE = 1;
const DIRECTORY = 2;
const SYMLINK = 64;

/** An in-memory `vscode.workspace.fs` with symlink entries. */
function fakeFs() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>(['/ws']);
  const symlinks = new Set<string>();
  let clock = 1;
  const mtimes = new Map<string, number>();
  const notFound = (uri: FakeUri) => FakeFileSystemError.FileNotFound(uri);
  return {
    files,
    directories,
    symlinks,
    fs: {
      async stat(uri: FakeUri) {
        const path = uri.path;
        if (symlinks.has(path)) return { type: SYMLINK | FILE, ctime: 0, mtime: 1, size: 1 };
        const implicitDirectory = [...files.keys()].some((file) => file.startsWith(`${path}/`));
        if (directories.has(path) || implicitDirectory) {
          return { type: DIRECTORY, ctime: 0, mtime: 0, size: 0 };
        }
        const data = files.get(path);
        if (!data) throw notFound(uri);
        return { type: FILE, ctime: 0, mtime: mtimes.get(path) ?? 0, size: data.byteLength };
      },
      async readDirectory(uri: FakeUri) {
        const prefix = `${uri.path}/`;
        const names = new Map<string, number>();
        for (const path of [...files.keys(), ...directories, ...symlinks]) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const name = rest.split('/')[0]!;
          const type = rest.includes('/')
            ? DIRECTORY
            : symlinks.has(path)
              ? SYMLINK | FILE
              : directories.has(path)
                ? DIRECTORY
                : FILE;
          names.set(name, type);
        }
        return [...names.entries()];
      },
      async readFile(uri: FakeUri) {
        const data = files.get(uri.path);
        if (!data) throw notFound(uri);
        return data;
      },
      async writeFile(uri: FakeUri, content: Uint8Array) {
        files.set(uri.path, content);
        mtimes.set(uri.path, ++clock);
      },
      async createDirectory(uri: FakeUri) {
        const segments = uri.path.split('/').filter(Boolean);
        for (let index = 1; index <= segments.length; index += 1) {
          directories.add(`/${segments.slice(0, index).join('/')}`);
        }
      },
    },
  };
}

function textOf(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

describe('VS Code workspace settings protocol', () => {
  it('accepts exact workspace settings requests and rejects malformed patches', () => {
    expect(
      parseWebviewToExtensionMessage({
        type: 'updateWorkspaceSettings',
        requestId: 3,
        patch: { documents: { defaultTheme: 'warm-earth' } },
      }),
    ).to.deep.equal({
      type: 'updateWorkspaceSettings',
      requestId: 3,
      patch: { documents: { defaultTheme: 'warm-earth' } },
    });
    expect(
      parseWebviewToExtensionMessage({ type: 'refreshWorkspaceOutputs', requestId: 4 }),
    ).to.deep.equal({ type: 'refreshWorkspaceOutputs', requestId: 4 });
    for (const bad of [
      { type: 'updateWorkspaceSettings', requestId: 1, patch: { documents: { other: 1 } } },
      {
        type: 'updateWorkspaceSettings',
        requestId: 1,
        patch: { catalog: { html: { path: '../x.html' } } },
      },
      { type: 'updateWorkspaceSettings', requestId: 1 },
      { type: 'refreshWorkspaceOutputs', requestId: 1, folder: '/etc' },
    ]) {
      expect(parseWebviewToExtensionMessage(bad), JSON.stringify(bad)).to.equal(null);
    }
  });

  it('validates the host state the webview renders', () => {
    const state = {
      status: 'ready',
      settings: { version: 1, catalog: { json: { enabled: true } } },
      writable: true,
      message: null,
      catalog: { state: 'done', message: null, documentCount: 3 },
    };
    expect(parseExtensionToWebviewMessage({ type: 'workspaceSettings', state })).to.deep.equal({
      type: 'workspaceSettings',
      state,
    });
    expect(
      parseExtensionToWebviewMessage({
        type: 'workspaceSettings',
        state: { ...state, settings: { version: 1, injected: true } },
      }),
    ).to.equal(null);
    expect(
      parseExtensionToWebviewMessage({
        type: 'workspaceSettingsResult',
        requestId: 1,
        ok: false,
        message: 'nope',
      }),
    ).to.deep.equal({ type: 'workspaceSettingsResult', requestId: 1, ok: false, message: 'nope' });
  });
});

describe('VS Code workspace filesystem adapter', () => {
  const root = new FakeUri('/ws');

  it('lists entries deterministically without following symbolic links', async () => {
    const { fs, files, symlinks } = fakeFs();
    files.set('/ws/b.md', new TextEncoder().encode('# B'));
    files.set('/ws/a.md', new TextEncoder().encode('# A'));
    symlinks.add('/ws/link.md');
    const io = ioModule.createVscodeWorkspaceIO(root as never, {
      fs: fs as never,
      isWritable: () => true,
    });
    const entries = await io.readDirectory(parseWorkspacePath(''));
    expect(entries.map((entry) => entry.path)).to.deep.equal(['a.md', 'b.md']);
  });

  it('honors create, replace and expected-version semantics', async () => {
    const { fs, files } = fakeFs();
    const io = ioModule.createVscodeWorkspaceIO(root as never, {
      fs: fs as never,
      isWritable: () => true,
    });
    const path = parseWorkspacePath('out/catalog.json');
    const created = await io.writeFile(path, new TextEncoder().encode('{}'), {
      mode: 'create',
      createParents: true,
      expectedVersion: null,
    });
    expect(textOf(files.get('/ws/out/catalog.json'))).to.equal('{}');

    const caught = async (run: () => Promise<unknown>): Promise<string | null> => {
      try {
        await run();
        return null;
      } catch (error) {
        return error instanceof FsError ? error.code : String(error);
      }
    };
    expect(
      await caught(() =>
        io.writeFile(path, new Uint8Array([1]), { mode: 'create', expectedVersion: null }),
      ),
    ).to.equal('already-exists');
    expect(
      await caught(() =>
        io.writeFile(path, new Uint8Array([1]), {
          mode: 'replace',
          expectedVersion: parseFileSystemVersion('stale'),
        }),
      ),
    ).to.equal('conflict');
    await io.writeFile(path, new TextEncoder().encode('{"a":1}'), {
      mode: 'replace',
      expectedVersion: created.version,
    });
    expect(textOf(files.get('/ws/out/catalog.json'))).to.equal('{"a":1}');
  });

  it('refuses read-only folders, unsaved open files, and symlinked parents', async () => {
    const { fs, symlinks } = fakeFs();
    symlinks.add('/ws/escape');
    const caught = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return null;
      } catch (error) {
        return error instanceof FsError ? error.code : String(error);
      }
    };
    const readOnly = ioModule.createVscodeWorkspaceIO(root as never, {
      fs: fs as never,
      isWritable: () => false,
    });
    expect(
      await caught(() => readOnly.writeFile(parseWorkspacePath('index.html'), new Uint8Array())),
    ).to.equal('permission-denied');
    const dirty = ioModule.createVscodeWorkspaceIO(root as never, {
      fs: fs as never,
      isWritable: () => true,
      isDirty: () => true,
    });
    expect(
      await caught(() => dirty.writeFile(parseWorkspacePath('index.html'), new Uint8Array())),
    ).to.equal('busy');
    const io = ioModule.createVscodeWorkspaceIO(root as never, {
      fs: fs as never,
      isWritable: () => true,
    });
    expect(
      await caught(() =>
        io.writeFile(parseWorkspacePath('escape/index.html'), new Uint8Array(), {
          createParents: true,
        }),
      ),
    ).to.equal('path-escape');
  });

  it('carries core catalog generation end to end', async () => {
    const { fs, files } = fakeFs();
    files.set('/ws/notes/a.md', new TextEncoder().encode('---\ntitle: Alpha\n---\n# A\n'));
    const io = ioModule.createVscodeWorkspaceIO(root as never, {
      fs: fs as never,
      isWritable: () => true,
    });
    const result = await refreshWorkspaceOutputs(
      io,
      { version: 1, catalog: { json: { enabled: true } } },
      { renderCatalogHtml: () => '<!DOCTYPE html>\n' },
    );
    expect(result.outputs[0]?.status).to.equal('written');
    const json = JSON.parse(textOf(files.get('/ws/catalog.json'))!);
    expect(json.documents).to.deep.equal([
      {
        path: 'notes/a.md',
        format: 'markdown',
        title: 'Alpha',
        outline: [{ level: 1, title: 'A' }],
        wordCount: 1,
      },
    ]);
  });
});

describe('workspace settings JSON Schema resource', () => {
  it('matches the schema core validates against', () => {
    const shipped: unknown = JSON.parse(
      readFileSync(new URL('../resources/workspace-settings.schema.json', import.meta.url), 'utf8'),
    );
    expect(
      shipped,
      'Regenerate resources/workspace-settings.schema.json from WORKSPACE_SETTINGS_JSON_SCHEMA',
    ).to.deep.equal(JSON.parse(JSON.stringify(WORKSPACE_SETTINGS_JSON_SCHEMA)));
  });
});
