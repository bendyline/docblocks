import { expect } from 'chai';
import {
  SHARED_DOCUMENT_LIMITS,
  createSharedDocumentHash,
  createSharedDocumentUrl,
  parseSharedDocumentHash,
  type SharedDocumentMode,
} from '../src/share/index.js';

function minimalArchive(extraBytes = 0): Uint8Array {
  const bytes = new Uint8Array(4 + extraBytes);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  for (let index = 4; index < bytes.byteLength; index += 1) bytes[index] = index % 251;
  return bytes;
}

describe('shared document URL wire format', () => {
  it('round-trips a bounded DBK and every optional launch mode', () => {
    const archive = minimalArchive(32);
    const modes: Array<SharedDocumentMode | null> = [
      null,
      'slideshow',
      'video',
      'page',
      'document',
      'narrate',
    ];

    for (const mode of modes) {
      const parsed = parseSharedDocumentHash(createSharedDocumentHash(archive, mode));
      expect(parsed.kind).to.equal('valid');
      if (parsed.kind !== 'valid') continue;
      expect(parsed.payload.mode).to.equal(mode);
      expect([...parsed.payload.archive]).to.deep.equal([...archive]);
    }
  });

  it('replaces an existing route hash without accepting non-HTTP URLs', () => {
    const url = createSharedDocumentUrl(
      'https://example.test/docblocks/?theme=dark#old-workspace/file.md',
      minimalArchive(),
      'video',
    );
    expect(url).to.match(/^https:\/\/example\.test\/docblocks\/\?theme=dark#shared\(/u);
    expect(() => createSharedDocumentUrl('file:///tmp/index.html', minimalArchive())).to.throw(
      /HTTP\(S\)/,
    );
  });

  it('distinguishes unrelated hashes from malformed shared input', () => {
    expect(parseSharedDocumentHash('#workspace/file.md')).to.deep.equal({ kind: 'none' });
    expect(parseSharedDocumentHash('#shared')).to.include({ kind: 'invalid' });
    expect(parseSharedDocumentHash('#shared(not base64)')).to.include({ kind: 'invalid' });
    expect(parseSharedDocumentHash('#shared(UEsDBA==)')).to.include({ kind: 'invalid' });
  });

  it('rejects oversized archives before base64 allocation', () => {
    expect(() =>
      createSharedDocumentHash(minimalArchive(SHARED_DOCUMENT_LIMITS.archiveBytes)),
    ).to.throw(/payload limit/);
    expect(
      parseSharedDocumentHash(`#shared(${'A'.repeat(SHARED_DOCUMENT_LIMITS.urlCharacters)})`),
    ).to.include({ kind: 'invalid' });
  });
});
