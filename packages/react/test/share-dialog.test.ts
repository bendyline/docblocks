import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseSharedDocumentHash } from '@bendyline/docblocks/share';
import { ShareDialog } from '../src/Export/ShareDialog.js';

describe('ShareDialog', () => {
  it('warns that the URL is a copy and updates the encoded default mode', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(ShareDialog, {
          markdown: '# Shared dialog',
          selectedFile: '/notes/dialog.md',
          baseUrl: 'https://example.test/docblocks/',
          onClose: () => undefined,
        }),
      );
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = container.querySelector<HTMLTextAreaElement>('#db-share-link')?.value;
      if (current) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(container.textContent).to.include('contents of this document are embedded in the URL');
    const select = container.querySelector<HTMLSelectElement>('#db-share-mode');
    const link = container.querySelector<HTMLTextAreaElement>('#db-share-link');
    expect(select).not.to.equal(null);
    expect(link?.value).to.include('#shared(');

    await act(async () => {
      if (!select) return;
      select.value = 'video';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const parsed = parseSharedDocumentHash(new URL(link?.value ?? '').hash);
    expect(parsed.kind).to.equal('valid');
    if (parsed.kind === 'valid') expect(parsed.payload.mode).to.equal('video');

    await act(async () => root.unmount());
    container.remove();
  });
});
