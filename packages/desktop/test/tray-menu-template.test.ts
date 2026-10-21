import { expect } from 'chai';
import type { HostPinnedDocument } from '@bendyline/docblocks/host';
import type { KeyboardEvent as ElectronKeyboardEvent, MenuItemConstructorOptions } from 'electron';

import {
  buildTrayMenuTemplate,
  pinnedDocumentLabels,
  type TrayMenuActions,
} from '../main/tray-menu-template.js';

const notes: HostPinnedDocument = { workspaceId: 'ws-1', workspaceName: 'Notes', path: 'plan.md' };
const work: HostPinnedDocument = {
  workspaceId: 'ws-2',
  workspaceName: 'Work',
  path: 'projects/roadmap.md',
};

function recordingActions(): { actions: TrayMenuActions; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      newDocument: () => calls.push('new'),
      openFolder: () => calls.push('open-folder'),
      openPinnedDocument: (document) =>
        calls.push(`pinned:${document.workspaceId}:${document.path}`),
      showWindow: () => calls.push('show'),
    },
  };
}

function click(item: MenuItemConstructorOptions | undefined): void {
  if (!item?.click) throw new Error('Expected a clickable menu item.');
  item.click({} as ElectronKeyboardEvent, undefined, undefined);
}

function labels(template: readonly MenuItemConstructorOptions[]): (string | undefined)[] {
  return template.map((item) => (item.type === 'separator' ? '---' : item.label));
}

describe('tray menu template', () => {
  it('offers the app actions without a pinned section when nothing is pinned', () => {
    const { actions } = recordingActions();
    expect(labels(buildTrayMenuTemplate([], actions, 'darwin'))).to.deep.equal([
      'New Document',
      'Open Folder...',
      '---',
      'Show DocBlocks',
      'Quit DocBlocks',
    ]);
  });

  it('lists pinned documents, in order, between the app actions', () => {
    const { actions } = recordingActions();
    expect(labels(buildTrayMenuTemplate([notes, work], actions, 'darwin'))).to.deep.equal([
      'New Document',
      'Open Folder...',
      '---',
      'Pinned',
      'plan',
      'roadmap',
      '---',
      'Show DocBlocks',
      'Quit DocBlocks',
    ]);
  });

  it('routes each item to its action', () => {
    const { actions, calls } = recordingActions();
    const template = buildTrayMenuTemplate([notes, work], actions, 'darwin');
    const byLabel = (label: string) => template.find((item) => item.label === label);

    click(byLabel('New Document'));
    click(byLabel('Open Folder...'));
    click(byLabel('roadmap'));
    click(byLabel('Show DocBlocks'));

    expect(calls).to.deep.equal(['new', 'open-folder', 'pinned:ws-2:projects/roadmap.md', 'show']);
    expect(byLabel('Pinned')?.enabled).to.equal(false);
  });

  it('quits through the quit role under a product-named label', () => {
    // The role's default label reads app.name, which is the package name in
    // an unpackaged run ("Quit docblocks-desktop").
    const { actions } = recordingActions();
    const quit = buildTrayMenuTemplate([], actions, 'win32').at(-1);
    expect(quit).to.include({ label: 'Quit DocBlocks', role: 'quit' });
  });

  it('names the workspace only when two pins share a name', () => {
    const otherPlan = { workspaceId: 'ws-2', workspaceName: 'Work', path: 'drafts/plan.md' };
    expect(pinnedDocumentLabels([notes, otherPlan, work], 'darwin')).to.deep.equal([
      'plan — Notes',
      'plan — Work',
      'roadmap',
    ]);
  });

  it('keeps a literal ampersand where the menu reads it as a mnemonic', () => {
    const ampersand = { ...notes, path: 'Q&A.md' };
    expect(pinnedDocumentLabels([ampersand], 'darwin')).to.deep.equal(['Q&A']);
    expect(pinnedDocumentLabels([ampersand], 'win32')).to.deep.equal(['Q&&A']);
    expect(pinnedDocumentLabels([ampersand], 'linux')).to.deep.equal(['Q&&A']);
  });

  it('bounds a pathological title', () => {
    const [label] = pinnedDocumentLabels([{ ...notes, path: `${'x'.repeat(200)}.md` }], 'darwin');
    expect(label).to.have.length(80);
    expect(label.endsWith('…')).to.equal(true);
  });
});
