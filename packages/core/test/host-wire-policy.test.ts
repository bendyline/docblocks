import { expect } from 'chai';
import {
  HOST_WIRE_LIMITS,
  isBoundedBytePayload,
  isBoundedString,
  isTrustedRendererUrl,
  parseExternalHttpUrl,
  parseOpenRequest,
} from '../src/host/index.js';

describe('host wire policy', () => {
  it('accepts only bounded NUL-free strings and byte payloads', () => {
    expect(isBoundedString('ok', 2, 1)).to.equal(true);
    expect(isBoundedString('too long', 2)).to.equal(false);
    expect(isBoundedString('bad\0value', 100)).to.equal(false);
    expect(isBoundedBytePayload(new Uint8Array(2), 2)).to.equal(true);
    expect(isBoundedBytePayload(new Uint8Array(3), 2)).to.equal(false);
  });

  it('canonicalizes HTTP(S) URLs and rejects credentials or other schemes', () => {
    expect(parseExternalHttpUrl('https://example.com/a/../b')).to.equal('https://example.com/b');
    expect(parseExternalHttpUrl('https://user:secret@example.com/')).to.equal(null);
    expect(parseExternalHttpUrl('file:///tmp/secret')).to.equal(null);
    expect(parseExternalHttpUrl('javascript:alert(1)')).to.equal(null);
    expect(parseExternalHttpUrl('data:text/html,<script>alert(1)</script>')).to.equal(null);
    expect(parseExternalHttpUrl('docblocks://open?path=/tmp/secret.md')).to.equal(null);
    expect(parseExternalHttpUrl('x'.repeat(HOST_WIRE_LIMITS.urlCharacters + 1))).to.equal(null);
  });

  it('requires the exact app host or configured development origin', () => {
    expect(isTrustedRendererUrl('app://docblocks/index.html')).to.equal(true);
    expect(isTrustedRendererUrl('app://other/index.html')).to.equal(false);
    expect(isTrustedRendererUrl('app://docblocks.example/index.html')).to.equal(false);
    expect(isTrustedRendererUrl('app://docblocks@evil.example/index.html')).to.equal(false);
    expect(isTrustedRendererUrl('app://docblocks:5221/index.html')).to.equal(false);
    expect(isTrustedRendererUrl('app:///index.html')).to.equal(false);
    expect(isTrustedRendererUrl('http://localhost:5221/src/main.tsx')).to.equal(false);
    expect(
      isTrustedRendererUrl('http://localhost:5221/src/main.tsx', 'http://localhost:5221'),
    ).to.equal(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:5221/', 'http://localhost:5221')).to.equal(false);
    expect(isTrustedRendererUrl('https://localhost:5221/', 'http://localhost:5221')).to.equal(
      false,
    );
    expect(
      isTrustedRendererUrl('http://localhost:5221.evil.example/', 'http://localhost:5221'),
    ).to.equal(false);
  });

  it('parses only exact bounded open-request payloads', () => {
    expect(
      parseOpenRequest({ kind: 'workspace-file', workspaceId: 'workspace-1', path: '/notes.md' }),
    ).to.deep.equal({ kind: 'workspace-file', workspaceId: 'workspace-1', path: '/notes.md' });
    expect(
      parseOpenRequest({ kind: 'external-bundle', resourceId: 'grant-1', name: 'notes.dbk' }),
    ).to.deep.equal({ kind: 'external-bundle', resourceId: 'grant-1', name: 'notes.dbk' });
    expect(
      parseOpenRequest({
        kind: 'external-file',
        resourceId: 'grant-1',
        name: 'notes.md',
        absolutePath: 'C:\\secret.md',
      }),
    ).to.equal(null);
    expect(
      parseOpenRequest({
        kind: 'workspace-file',
        workspaceId: 'workspace-1',
        path: 'x'.repeat(HOST_WIRE_LIMITS.pathCharacters + 1),
      }),
    ).to.equal(null);
    expect(parseOpenRequest({ kind: 'unknown' })).to.equal(null);
  });
});
