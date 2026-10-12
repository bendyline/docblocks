/**
 * Workspace-scoped settings in the shell: the `.docblocks/workspace.json`
 * store (read states, conflict merge, never overwriting a file it cannot
 * understand), the catalog-output scheduler (debounce, single flight, its own
 * writes never re-trigger it, disposal cancels), the export dialog's theme
 * layering, and the Workspace settings dialog's save contract.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MemoryFileSystemProvider,
  parseWorkspacePath,
  type FileSystemProviderV2,
} from '@bendyline/docblocks/filesystem';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import {
  createWorkspaceOutputsScheduler,
  IDLE_WORKSPACE_OUTPUTS_STATUS,
  readWorkspaceSettings,
  saveWorkspaceSettingsPatch,
  WORKSPACE_SETTINGS_PATH,
  type WorkspaceOutputsRenderer,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from '@bendyline/docblocks/workspace-settings';
import { DEFAULT_OPTIONS, resolveExportDialogInitial } from '../src/Export/export-options.js';
import { WorkspaceSettingsDialog } from '../src/WorkspacePicker/WorkspaceSettingsDialog.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

let count = 0;
function createProvider(): { provider: MemoryFileSystemProvider; v2: FileSystemProviderV2 } {
  count += 1;
  const provider = new MemoryFileSystemProvider(`ws-settings-${count}`, 'Workspace');
  return { provider, v2: provider.v2 };
}

async function writeText(v2: FileSystemProviderV2, path: string, text: string): Promise<void> {
  await v2.writeFile(parseWorkspacePath(path), new TextEncoder().encode(text), {
    createParents: true,
  });
}

async function readText(v2: FileSystemProviderV2, path: string): Promise<string | null> {
  const file = await v2.readFile(parseWorkspacePath(path));
  return file ? new TextDecoder().decode(file.data) : null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('workspace settings store', () => {
  it('reports a missing file without creating one', async () => {
    const { v2 } = createProvider();
    const state = await readWorkspaceSettings(v2);
    expect(state).to.deep.equal({
      status: 'missing',
      settings: null,
      version: null,
      message: null,
    });
    expect(await readText(v2, WORKSPACE_SETTINGS_PATH)).to.equal(null);
  });

  it('creates the file on the first save and reads it back', async () => {
    const { v2 } = createProvider();
    const saved = await saveWorkspaceSettingsPatch(v2, await readWorkspaceSettings(v2), {
      documents: { defaultTheme: 'warm-earth' },
    });
    expect(saved.status).to.equal('ready');
    expect(await readText(v2, WORKSPACE_SETTINGS_PATH)).to.equal(
      '{\n  "version": 1,\n  "documents": {\n    "defaultTheme": "warm-earth"\n  }\n}\n',
    );
    const reread = await readWorkspaceSettings(v2);
    expect(reread.settings).to.deep.equal({
      version: 1,
      documents: { defaultTheme: 'warm-earth' },
    });
    expect(reread.version).to.equal(saved.version);
  });

  it('does not create the file when the saved settings are only defaults', async () => {
    const { v2 } = createProvider();
    const saved = await saveWorkspaceSettingsPatch(v2, await readWorkspaceSettings(v2), {
      // A title for a catalog that is not turned on changes nothing.
      catalog: { title: 'Articles', html: { enabled: false } },
    });
    expect(saved).to.deep.equal({
      status: 'missing',
      settings: null,
      version: null,
      message: null,
    });
    expect(await readText(v2, WORKSPACE_SETTINGS_PATH)).to.equal(null);
    expect(await v2.stat(parseWorkspacePath('.docblocks'))).to.equal(null);
  });

  it('still updates an existing file back to defaults rather than deleting it', async () => {
    const { v2 } = createProvider();
    const created = await saveWorkspaceSettingsPatch(v2, await readWorkspaceSettings(v2), {
      documents: { defaultTheme: 'warm-earth' },
    });
    const cleared = await saveWorkspaceSettingsPatch(v2, created, {
      documents: { defaultTheme: null },
    });
    expect(cleared.status).to.equal('ready');
    expect(await readText(v2, WORKSPACE_SETTINGS_PATH)).to.equal('{\n  "version": 1\n}\n');
  });

  it('merges with a concurrent change instead of overwriting it', async () => {
    const { v2 } = createProvider();
    const observed = await readWorkspaceSettings(v2);
    // Another window creates the file after this one read it.
    await writeText(v2, WORKSPACE_SETTINGS_PATH, '{"version":1,"versionHistory":{"keep":7}}');
    const saved = await saveWorkspaceSettingsPatch(v2, observed, {
      documents: { defaultTheme: 'warm-earth' },
    });
    expect(saved.settings).to.deep.equal({
      version: 1,
      documents: { defaultTheme: 'warm-earth' },
      versionHistory: { keep: 7 },
    });
  });

  it('never overwrites an invalid or newer file', async () => {
    const { v2 } = createProvider();
    await writeText(v2, WORKSPACE_SETTINGS_PATH, '{"version":1,"mystery":true}');
    const invalid = await readWorkspaceSettings(v2);
    expect(invalid.status).to.equal('invalid');
    expect(invalid.settings).to.equal(null);
    let error: unknown;
    try {
      await saveWorkspaceSettingsPatch(v2, invalid, { documents: { defaultTheme: 'x' } });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect(await readText(v2, WORKSPACE_SETTINGS_PATH)).to.equal('{"version":1,"mystery":true}');

    await writeText(v2, WORKSPACE_SETTINGS_PATH, '{"version":9}');
    expect((await readWorkspaceSettings(v2)).status).to.equal('unsupported-version');
  });
});

describe('workspace catalog scheduler', () => {
  const renderer: WorkspaceOutputsRenderer = {
    renderCatalogHtml: (_document, { title }) => `<!DOCTYPE html>\n<title>${title}</title>\n`,
  };
  const settings: WorkspaceSettings = {
    version: 1,
    catalog: { json: { enabled: true } },
  };

  it('debounces bursts of changes into one refresh and ignores its own outputs', async () => {
    const { v2 } = createProvider();
    await writeText(v2, 'a.md', '# A');
    const writes: string[] = [];
    const write = v2.writeFile.bind(v2);
    v2.writeFile = async (path, data, options) => {
      writes.push(path);
      return write(path, data, options);
    };
    const scheduler = createWorkspaceOutputsScheduler({
      workspaceId: 'w',
      provider: v2,
      settings,
      renderer,
      debounceMs: 20,
      maxWaitMs: 500,
    });
    scheduler.notify('a.md');
    scheduler.notify('a.md');
    scheduler.notify('catalog.json');
    await wait(80);
    expect(writes).to.deep.equal(['catalog.json']);
    expect(scheduler.getStatus().state).to.equal('done');
    expect(scheduler.getStatus().result?.documentCount).to.equal(1);

    // Its own write is not a reason to run again; an unchanged walk writes nothing.
    scheduler.notify('catalog.json');
    scheduler.notify('a_files/.versions/a.md');
    await wait(60);
    expect(writes).to.deep.equal(['catalog.json']);
    scheduler.dispose();
  });

  it('re-runs once when a change arrives mid-run', async () => {
    const { v2 } = createProvider();
    await writeText(v2, 'a.md', '# A');
    const scheduler = createWorkspaceOutputsScheduler({
      workspaceId: 'w',
      provider: v2,
      settings,
      renderer,
      debounceMs: 5,
    });
    const first = scheduler.regenerate();
    await writeText(v2, 'b.md', '# B');
    scheduler.notify('b.md');
    await first;
    await wait(60);
    const json = JSON.parse((await readText(v2, 'catalog.json'))!);
    expect(json.documents.map((entry: { path: string }) => entry.path)).to.deep.equal([
      'a.md',
      'b.md',
    ]);
    scheduler.dispose();
  });

  it('does nothing when outputs are off, and stops when disposed', async () => {
    const { v2 } = createProvider();
    await writeText(v2, 'a.md', '# A');
    const scheduler = createWorkspaceOutputsScheduler({
      workspaceId: 'w',
      provider: v2,
      settings: { version: 1 },
      renderer,
      debounceMs: 5,
    });
    scheduler.notify('a.md');
    await wait(30);
    expect(await readText(v2, 'catalog.json')).to.equal(null);
    scheduler.updateSettings(settings);
    scheduler.dispose();
    await wait(30);
    expect(await readText(v2, 'catalog.json')).to.equal(null);
  });

  it('reports a blocked output instead of replacing a hand-written file', async () => {
    const { v2 } = createProvider();
    await writeText(v2, 'catalog.json', '{"mine":true}');
    const scheduler = createWorkspaceOutputsScheduler({
      workspaceId: 'w',
      provider: v2,
      settings,
      renderer,
      debounceMs: 5,
    });
    const status = await scheduler.regenerate();
    expect(status.state).to.equal('done');
    expect(status.message).to.match(/not created by DocBlocks/);
    expect(await readText(v2, 'catalog.json')).to.equal('{"mine":true}');
    scheduler.dispose();
  });
});

describe('export dialog theme layering', () => {
  it('prefers the document theme, then the workspace default, then the last-used theme', () => {
    const last = { ...DEFAULT_OPTIONS, themeId: 'gezellig' };
    expect(resolveExportDialogInitial(last, 'dusk', 'warm-earth').themeId).to.equal('dusk');
    expect(resolveExportDialogInitial(last, undefined, 'warm-earth').themeId).to.equal(
      'warm-earth',
    );
    expect(resolveExportDialogInitial(last, null, undefined).themeId).to.equal('gezellig');
    expect(resolveExportDialogInitial(null, null).themeId).to.equal('standard');
  });
});

describe('WorkspaceSettingsDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  const saved: WorkspaceSettingsPatch[] = [];

  const workspace: WorkspaceDescriptor = {
    id: 'w',
    name: 'Articles',
    type: 'native',
    lastOpened: new Date('2026-10-01T00:00:00.000Z').toISOString(),
    versioningOverride: 'on',
  };

  async function render(status: 'missing' | 'invalid') {
    await act(async () => {
      root.render(
        createElement(WorkspaceSettingsDialog, {
          workspace,
          globalVersioningPreference: 'browser-only',
          settings:
            status === 'missing'
              ? { status, settings: null, version: null, message: null }
              : { status, settings: null, version: null, message: 'Bad field "x".' },
          showVersionHistory: true,
          outputsStatus: IDLE_WORKSPACE_OUTPUTS_STATUS,
          onSave: async (patch) => {
            saved.push(patch);
          },
          onRegenerate: () => undefined,
          onClose: () => undefined,
        }),
      );
    });
  }

  beforeEach(() => {
    saved.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('moves the legacy browser-local override into the file on the first save', async () => {
    await render('missing');
    const onRadio = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (input) => input.value === 'on',
    );
    expect(onRadio?.checked).to.equal(true);
    const catalogPage = [...document.querySelectorAll<HTMLLabelElement>('label')].find((label) =>
      label.textContent?.includes('Catalog page'),
    );
    await act(async () => {
      catalogPage?.querySelector('input')?.click();
    });
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Save',
    );
    expect(save?.disabled).to.equal(false);
    await act(async () => {
      save?.click();
    });
    expect(saved).to.deep.equal([
      { versionHistory: { enabled: true }, catalog: { html: { enabled: true } } },
    ]);
  });

  it('shows an unusable file read-only with its reason', async () => {
    await render('invalid');
    expect(document.body.textContent).to.contain('Bad field "x".');
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.db-dialog button')].map(
      (button) => button.textContent,
    );
    expect(buttons).not.to.include('Save');
    const inputs = [...document.querySelectorAll<HTMLFieldSetElement>('fieldset')];
    expect(inputs.every((fieldset) => fieldset.disabled)).to.equal(true);
  });
});
