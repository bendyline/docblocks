import { expect } from 'chai';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';
import { act } from './helpers/renderHook.js';

describe('FileExplorer temporary workspace move', () => {
  it('opens an inline destination picker and submits the selected workspace', async () => {
    const provider = new MemoryFileSystemProvider('temporary-ui', 'Shared document');
    provider.seedText('shared.md', '# Shared');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let selectedWorkspaceId: string | null = null;

    try {
      await act(async () => {
        root.render(
          createElement(FileExplorer, {
            provider,
            moveDestinations: [
              { id: 'personal', name: 'My Documents' },
              { id: 'project', name: 'Project Notes' },
            ],
            onMoveToWorkspace: async (workspaceId: string) => {
              selectedWorkspaceId = workspaceId;
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const trigger = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Move this into a workspace',
      );
      expect(trigger).not.to.equal(undefined);
      await act(async () => trigger?.click());

      const form = container.querySelector<HTMLFormElement>('.db-transient-move-form');
      const select = container.querySelector<HTMLSelectElement>('.db-transient-move-select');
      expect(form?.getAttribute('aria-label')).to.equal('Move this into a workspace');
      expect(select?.options).to.have.length(2);
      await act(async () => {
        if (!select) return;
        select.value = 'project';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await act(async () => {
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(selectedWorkspaceId).to.equal('project');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });
});
