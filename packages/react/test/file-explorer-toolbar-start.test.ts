import { expect } from 'chai';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';
import { act } from './helpers/renderHook.js';

async function renderExplorer(props: Partial<Parameters<typeof FileExplorer>[0]>) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(FileExplorer, {
        provider: new MemoryFileSystemProvider('work', 'Work'),
        workspaceName: 'Work',
        ...props,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe('FileExplorer toolbarStart', () => {
  it('leads the toolbar with the host controls, below the pins, in place of the name', async () => {
    const view = await renderExplorer({
      activeWorkspaceId: 'work',
      pinnedDocuments: [
        { workspaceId: 'work', workspaceName: 'Work', path: 'draft.md', availability: 'available' },
      ],
      onPinnedDocumentSelect: () => {},
      toolbarStart: createElement('button', { type: 'button' }, 'Switch workspace'),
    });

    try {
      const toolbar = view.container.querySelector('.db-explorer-toolbar')!;
      expect(toolbar.classList.contains('db-explorer-toolbar--workspace')).to.equal(true);
      expect(toolbar.querySelector('.db-explorer-workspace-name')).to.equal(null);

      const controls = toolbar.firstElementChild!;
      expect(controls.className).to.equal('db-explorer-workspace-controls');
      expect(controls.textContent).to.equal('Switch workspace');
      expect(controls.nextElementSibling!.className).to.equal('db-explorer-actions');

      const pins = view.container.querySelector('.db-pinned-documents')!;
      expect(
        Boolean(pins.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).to.equal(true);
    } finally {
      await view.unmount();
    }
  });

  it('keeps the workspace-name heading when the host passes no controls', async () => {
    const view = await renderExplorer({});

    try {
      const toolbar = view.container.querySelector('.db-explorer-toolbar')!;
      expect(toolbar.classList.contains('db-explorer-toolbar--workspace')).to.equal(false);
      expect(toolbar.querySelector('.db-explorer-workspace-controls')).to.equal(null);
      expect(toolbar.querySelector('.db-explorer-workspace-name')!.textContent).to.equal('Work');
    } finally {
      await view.unmount();
    }
  });
});
