import { expect } from 'chai';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';
import { act } from './helpers/renderHook.js';

describe('FileExplorer active file', () => {
  it('expands ancestor folders and selects a document opened outside the tree', async () => {
    const provider = new MemoryFileSystemProvider('mem', 'Memory');
    await provider.v2.createDirectory(parseWorkspacePath('guides'), { mode: 'create' });
    await provider.v2.createDirectory(parseWorkspacePath('guides/advanced'), { mode: 'create' });
    await provider.v2.writeFile(
      parseWorkspacePath('guides/advanced/intro.md'),
      new TextEncoder().encode('# Intro'),
      { mode: 'create' },
    );

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(FileExplorer, {
            provider,
            activeFilePath: '/guides/advanced/intro.md',
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const rows = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      const guides = rows.find((row) => row.textContent?.includes('guides'));
      const advanced = rows.find((row) => row.textContent?.includes('advanced'));
      const intro = rows.find((row) => row.textContent?.includes('intro'));

      expect(guides?.getAttribute('aria-expanded')).to.equal('true');
      expect(advanced?.getAttribute('aria-expanded')).to.equal('true');
      expect(intro?.getAttribute('aria-selected')).to.equal('true');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });
});
