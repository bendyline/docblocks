import { expect } from 'chai';
import { resolveEditorLinkTarget } from '../src/editorLinkNavigation.js';

describe('VS Code editor link navigation', () => {
  it('canonicalizes HTTP(S) links for external navigation', () => {
    expect(resolveEditorLinkTarget('https://example.com/a/../guide', null)).to.deep.equal({
      kind: 'external',
      url: 'https://example.com/guide',
    });
  });

  it('resolves relative and workspace-root links from the active document', () => {
    expect(resolveEditorLinkTarget('../llms.txt', 'docs-src/guide/agent-loop.md')).to.deep.equal({
      kind: 'workspace',
      path: 'docs-src/llms.txt',
    });
    expect(
      resolveEditorLinkTarget('/docs-src/guide/scripting.md?mode=read#game-logic', 'README.md'),
    ).to.deep.equal({ kind: 'workspace', path: 'docs-src/guide/scripting.md' });
    expect(resolveEditorLinkTarget('my%20notes.md', 'docs-src/index.md')).to.deep.equal({
      kind: 'workspace',
      path: 'docs-src/my notes.md',
    });
  });

  it('rejects local paths that escape or bypass the workspace authority', () => {
    expect(resolveEditorLinkTarget('../../../outside.md', 'docs/guide/page.md')).to.equal(null);
    expect(resolveEditorLinkTarget('file:///tmp/secret.md', 'docs/page.md')).to.equal(null);
    expect(resolveEditorLinkTarget('//server/share/file.md', 'docs/page.md')).to.equal(null);
    expect(resolveEditorLinkTarget('%2e%2e/%2e%2e/secret.md', 'docs/page.md')).to.equal(null);
    expect(resolveEditorLinkTarget('javascript:alert(1)', 'docs/page.md')).to.equal(null);
    expect(resolveEditorLinkTarget('../next.md', null)).to.equal(null);
  });
});
