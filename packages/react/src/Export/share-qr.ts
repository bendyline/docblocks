import QRCode from 'qrcode';

/**
 * Render a high-resolution PNG locally. Medium error correction retains a
 * useful damage budget while allowing the explicit 2K-character ceiling.
 */
export async function renderSharedDocumentQrPng(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 1024,
    color: {
      dark: '#111111ff',
      light: '#ffffffff',
    },
  });
}

/** Convert the QR renderer's bounded PNG data URL into a ClipboardItem payload. */
export function qrPngDataUrlToBlob(dataUrl: string): Blob {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) {
    throw new Error('The QR code renderer returned an unsupported image format.');
  }
  const binary = atob(dataUrl.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: 'image/png' });
}
