import { expect } from 'chai';
import {
  isDocumentMediaPath,
  resolveDocumentRelativeMediaPath,
} from '../src/filesystem/document-relative-media.js';

describe('document-relative media paths', () => {
  it('resolves references against the document folder', () => {
    expect(resolveDocumentRelativeMediaPath('', 'shots/journey/j02.png')).to.equal(
      'shots/journey/j02.png',
    );
    expect(resolveDocumentRelativeMediaPath('reports', './shots/a.png')).to.equal(
      'reports/shots/a.png',
    );
    expect(resolveDocumentRelativeMediaPath('reports/2026', '../shared/a.webp')).to.equal(
      'reports/shared/a.webp',
    );
  });

  it('decodes escapes and drops queries and fragments', () => {
    expect(resolveDocumentRelativeMediaPath('', 'my%20shot.png?v=2#frag')).to.equal('my shot.png');
    // A stray percent sign is part of the file name.
    expect(resolveDocumentRelativeMediaPath('', '100%.png')).to.equal('100%.png');
    expect(resolveDocumentRelativeMediaPath('', 'shots\\a.png')).to.equal('shots/a.png');
  });

  it('never climbs above the root', () => {
    expect(resolveDocumentRelativeMediaPath('', '../a.png')).to.equal(null);
    expect(resolveDocumentRelativeMediaPath('reports', '../../a.png')).to.equal(null);
    expect(resolveDocumentRelativeMediaPath('reports', 'shots/%2e%2e/%2e%2e/../a.png')).to.equal(
      null,
    );
  });

  it('rejects URLs, rooted and drive-qualified paths', () => {
    for (const ref of [
      'https://example.com/a.png',
      'data:image/png;base64,AAAA',
      'blob:abc',
      'C:/Users/a.png',
      '/etc/a.png',
      '\\\\server\\share\\a.png',
      '',
      '?only-a-query',
    ]) {
      expect(resolveDocumentRelativeMediaPath('', ref), ref).to.equal(null);
    }
  });

  it('reads only image, audio, and video files', () => {
    expect(resolveDocumentRelativeMediaPath('', 'notes.md')).to.equal(null);
    expect(resolveDocumentRelativeMediaPath('', '.ssh/id_ed25519')).to.equal(null);
    expect(resolveDocumentRelativeMediaPath('', 'shots')).to.equal(null);
    expect(isDocumentMediaPath('a/B.JPG')).to.equal(true);
    expect(isDocumentMediaPath('clip.webm')).to.equal(true);
    expect(isDocumentMediaPath('voice.mp3')).to.equal(true);
    expect(isDocumentMediaPath('data.json')).to.equal(false);
    expect(isDocumentMediaPath('png')).to.equal(false);
  });

  it('refuses a document folder that is not a canonical path', () => {
    expect(resolveDocumentRelativeMediaPath('../outside', 'a.png')).to.equal(null);
  });
});
