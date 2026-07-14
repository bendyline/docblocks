import { expect } from 'chai';
import { SHARED_DOCUMENT_LIMITS, parseSharedDocumentHash } from '@bendyline/docblocks/share';
import {
  buildSharedDocumentUrl,
  createSharedDocumentArchive,
  resolveSharedDocumentBaseUrl,
  sharedDocumentFilename,
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
      'https://bendyline.github.io/docblocks/',
    );
    expect(sharedDocumentFilename('/drafts/launch plan.md')).to.equal('launch-plan.md');
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
