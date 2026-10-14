import { expect } from 'chai';
import { SHARED_DOCUMENT_LIMITS, parseSharedDocumentHash } from '@bendyline/docblocks/share';
import {
  buildSharedDocumentQrUrl,
  buildSharedDocumentUrl,
  createSharedDocumentArchive,
  resolveSharedDocumentBaseUrl,
  sharedDocumentFilename,
  sharedDocumentQrFilename,
} from '../src/Export/shared-document.js';
import { decodeDbkWorkspace } from '../src/DocBlocksShell/dbk-import.js';

describe('shared document links', () => {
  it('packages one Markdown file and restores it through the strict transient DBK path', async () => {
    const markdown = '# Shared\n\n<script>globalThis.pwned = true</script>\n';
    const archive = await createSharedDocumentArchive(markdown, '/drafts/launch plan.md');
    const url = buildSharedDocumentUrl(
      'https://example.test/app/#workspace/doc.md',
      archive,
      'video',
    );
    const parsed = parseSharedDocumentHash(new URL(url).hash);

    expect(parsed.kind).to.equal('valid');
    if (parsed.kind !== 'valid') return;
    expect(parsed.payload.mode).to.equal('video');
    const snapshot = await decodeDbkWorkspace(parsed.payload.archive, {
      targetDocumentPath: 'shared.md',
      profile: 'shared-link',
    });
    expect(snapshot.files).to.have.length(1);
    expect(snapshot.documentContent).to.equal(markdown);
  });

  it('uses the current HTTP deployment and falls back from app URLs', () => {
    expect(resolveSharedDocumentBaseUrl('https://example.test/app/?action=new#old')).to.equal(
      'https://example.test/app/',
    );
    expect(resolveSharedDocumentBaseUrl('app://docblocks/index.html#old')).to.equal(
      'https://docblocks.com/',
    );
    expect(sharedDocumentFilename('/drafts/launch plan.md')).to.equal('launch-plan.md');
    expect(sharedDocumentQrFilename('/drafts/launch plan.md')).to.equal('launch-plan-qr.png');
  });

  it('shares image descriptions without local, remote, reference, or HTML image URLs', async () => {
    const markdown = [
      '# Shared',
      '**Keep this formatting** and [Guide](https://example.test/guide).',
      '![Local caption](assets/photo.png)',
      '![Remote caption](https://example.test/photo.png)',
      '![Reference caption][photo]',
      '![Shortcut caption]',
      '![Collapsed caption][]',
      '<img src="https://example.test/html.png" alt="HTML caption">',
      '![](assets/no-description.png)',
      '[photo]: assets/reference.png',
      '[Shortcut caption]: assets/shortcut.png',
      '[Collapsed caption]: assets/collapsed.png',
    ].join('\n\n');
    const archive = await createSharedDocumentArchive(markdown, 'images.md');
    const snapshot = await decodeDbkWorkspace(archive, {
      targetDocumentPath: 'shared.md',
      profile: 'shared-link',
    });
    expect(snapshot.files).to.have.length(1);
    expect(snapshot.documentContent).to.include(
      '**Keep this formatting** and [Guide](https://example.test/guide).',
    );
    for (const caption of ['Local', 'Remote', 'Reference', 'Shortcut', 'Collapsed', 'HTML']) {
      expect(snapshot.documentContent).to.include(`${caption} caption`);
    }
    expect(snapshot.documentContent).not.to.include('.png');
    expect(snapshot.documentContent).not.to.include('![');
    expect(snapshot.documentContent).not.to.include('<img');
  });

  it('retains reference definitions used by text links when removing their images', async () => {
    const markdown =
      '![Preview][RESOURCE]\n\n[Read more][resource]\n\n[resource]: https://example.test/resource\n';
    const archive = await createSharedDocumentArchive(markdown, 'references.md');
    const snapshot = await decodeDbkWorkspace(archive, {
      targetDocumentPath: 'shared.md',
      profile: 'shared-link',
    });
    expect(snapshot.documentContent).to.equal(
      'Preview\n\n[Read more][resource]\n\n[resource]: https://example.test/resource\n',
    );
  });

  it('does not turn Markdown-looking HTML image descriptions into shared images', async () => {
    const markdown =
      '<img src="outer.png" alt="![Inner description][inner]">\n\n[inner]: inner.png\n';
    const archive = await createSharedDocumentArchive(markdown, 'description.md');
    const snapshot = await decodeDbkWorkspace(archive, {
      targetDocumentPath: 'shared.md',
      profile: 'shared-link',
    });
    expect(snapshot.documentContent).to.equal('Inner description\n\n\n');
  });

  it('preserves image syntax in code examples and escaped prose', async () => {
    const markdown = [
      '---\ntitle: Sharing guide\n---',
      'Example: `![caption](example.png)` and `<img src="example.png">`.',
      '```md\n![caption](example.png)\n<img src="example.png">\n```',
      '\\![caption](example.png)',
      '![Actual image](actual.png)',
    ].join('\n\n');
    const archive = await createSharedDocumentArchive(markdown, 'guide.md');
    const snapshot = await decodeDbkWorkspace(archive, {
      targetDocumentPath: 'shared.md',
      profile: 'shared-link',
    });
    expect(snapshot.documentContent).to.equal(
      markdown.replace('![Actual image](actual.png)', 'Actual image'),
    );
  });

  it('removes embedded image bytes before applying the shared-text size budget', async () => {
    const imageUrl = `data:image/png;base64,${'A'.repeat(SHARED_DOCUMENT_LIMITS.markdownBytes)}`;
    const markdown = `# Photos\n\n![Inline caption](${imageUrl})\n\n![Reference caption][photo]\n\n[photo]: ${imageUrl}\n`;
    const archive = await createSharedDocumentArchive(markdown, 'photos.md');
    const snapshot = await decodeDbkWorkspace(archive, {
      targetDocumentPath: 'shared.md',
      profile: 'shared-link',
    });
    expect(snapshot.documentContent).to.equal(
      '# Photos\n\nInline caption\n\nReference caption\n\n\n',
    );
  });

  it('builds QR links against the canonical public site and enforces the QR budget', async () => {
    const archive = await createSharedDocumentArchive('# QR share', 'qr.md');
    const url = buildSharedDocumentQrUrl(archive, 'page');
    expect(url).to.match(/^https:\/\/docblocks\.com\/#shared\(/u);
    expect(url.length).to.be.at.most(SHARED_DOCUMENT_LIMITS.qrUrlCharacters);

    const oversizedArchive = new Uint8Array(1_600);
    oversizedArchive.set([0x50, 0x4b, 0x03, 0x04]);
    expect(() => buildSharedDocumentQrUrl(oversizedArchive, null)).to.throw(
      'too large for a reliable QR code',
    );
  });

  it('rejects Markdown beyond the explicit uncompressed content budget', async () => {
    let thrown: unknown;
    try {
      await createSharedDocumentArchive(
        'x'.repeat(SHARED_DOCUMENT_LIMITS.markdownBytes + 1),
        'large.md',
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as Error).message).to.include('too large');
  });

  it('reopens highly compressible Markdown at the exact source limit', async () => {
    const markdown = 'x'.repeat(SHARED_DOCUMENT_LIMITS.markdownBytes);
    const archive = await createSharedDocumentArchive(markdown, 'repetitive.md');
    const snapshot = await decodeDbkWorkspace(archive, {
      targetDocumentPath: 'shared.md',
      profile: 'shared-link',
    });
    expect(snapshot.documentContent).to.equal(markdown);
  });
});
