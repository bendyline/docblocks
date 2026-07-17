import { expect } from 'chai';
import { resolveShellEditorLinkTarget } from '../src/DocBlocksShell/editor-link-navigation.js';

describe('shell editor link navigation', () => {
  it('canonicalizes safe HTTP(S) links and preserves fragment-only browser navigation', () => {
    expect(
      resolveShellEditorLinkTarget('https://example.com/docs/../guide', 'docs/current.md'),
    ).to.deep.equal({ kind: 'external', url: 'https://example.com/guide' });
    expect(resolveShellEditorLinkTarget('#details', 'docs/current.md')).to.deep.equal({
      kind: 'fragment',
    });
  });

  it('resolves relative and workspace-root Markdown links', () => {
    expect(
      resolveShellEditorLinkTarget('../reference/guide.md#start', '/docs/setup/current.md'),
    ).to.deep.equal({ kind: 'workspace', path: 'docs/reference/guide.md' });
    expect(
      resolveShellEditorLinkTarget('/reference/guide.markdown?mode=read', 'docs/current.md'),
    ).to.deep.equal({ kind: 'workspace', path: 'reference/guide.markdown' });
  });

  it('rejects paths outside the workspace and non-document link targets', () => {
    expect(resolveShellEditorLinkTarget('../../outside.md', 'docs/current.md')).to.equal(null);
    expect(resolveShellEditorLinkTarget('image.png', 'docs/current.md')).to.equal(null);
    expect(resolveShellEditorLinkTarget('//example.com/guide', 'docs/current.md')).to.equal(null);
  });

  it('rejects unsafe external schemes, credentials, malformed encoding, and controls', () => {
    expect(resolveShellEditorLinkTarget('javascript:alert(1)', 'docs/current.md')).to.equal(null);
    expect(resolveShellEditorLinkTarget('file:///tmp/secret.md', 'docs/current.md')).to.equal(null);
    expect(
      resolveShellEditorLinkTarget('https://user:secret@example.com/', 'docs/current.md'),
    ).to.equal(null);
    expect(resolveShellEditorLinkTarget('%not-encoded.md', 'docs/current.md')).to.equal(null);
    expect(resolveShellEditorLinkTarget('linked\0.md', 'docs/current.md')).to.equal(null);
  });
});
