import { expect } from 'chai';
import { qrPngDataUrlToBlob, renderSharedDocumentQrPng } from '../src/Export/share-qr.js';

describe('shared-document QR images', () => {
  it('renders a local high-resolution PNG suitable for download or clipboard use', async () => {
    const dataUrl = await renderSharedDocumentQrPng(
      'https://docblocks.com/#shared(REJLU0hBUkUBAA==)',
    );
    const blob = qrPngDataUrlToBlob(dataUrl);

    expect(dataUrl).to.match(/^data:image\/png;base64,/u);
    expect(blob.type).to.equal('image/png');
    expect(blob.size).to.be.greaterThan(100);
  });

  it('renders an ASCII URL at the full 2,048-character product limit', async () => {
    const prefix = 'https://docblocks.com/#shared(';
    const url = prefix + 'a'.repeat(2_048 - prefix.length - 1) + ')';
    const dataUrl = await renderSharedDocumentQrPng(url);

    expect(url).to.have.length(2_048);
    expect(dataUrl).to.match(/^data:image\/png;base64,/u);
  });

  it('rejects non-PNG data URLs at the clipboard boundary', () => {
    expect(() => qrPngDataUrlToBlob('data:image/svg+xml;base64,PHN2Zy8+')).to.throw(
      'unsupported image format',
    );
  });
});
