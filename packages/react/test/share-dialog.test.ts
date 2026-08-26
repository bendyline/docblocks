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

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (container.querySelector<HTMLImageElement>('.db-share-qr-image')) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    const qrImage = container.querySelector<HTMLImageElement>('.db-share-qr-image');
    const saveQrButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Save QR PNG',
    );
    expect(qrImage?.src).to.match(/^data:image\/png;base64,/u);
    expect(qrImage?.alt).to.include('QR code');
    expect(container.textContent).to.include('docblocks.com link');
    expect(saveQrButton?.disabled).to.equal(false);

    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const previousClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
    const copied: Array<Record<string, Blob>> = [];
    class TestClipboardItem {
      constructor(readonly data: Record<string, Blob>) {
        copied.push(data);
      }
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: async () => undefined },
    });
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: TestClipboardItem,
    });

    try {
      const copyQrButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Copy QR image',
      );
      await act(async () => copyQrButton?.click());
      expect(copied).to.have.length(1);
      expect(copied[0]?.['image/png']).to.be.instanceOf(Blob);
      expect(copyQrButton?.textContent).to.equal('Copied QR');
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
      if (previousClipboardItem) {
        Object.defineProperty(globalThis, 'ClipboardItem', previousClipboardItem);
      } else {
        Reflect.deleteProperty(globalThis, 'ClipboardItem');
      }
    }

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
