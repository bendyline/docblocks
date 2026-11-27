import { expect } from 'chai';
import {
  WORKSPACE_KNOWLEDGE_CATALOG_ID,
  parseWorkspacePassageUri,
  withWorkspaceCatalogId,
  workspacePassageUri,
} from '../src/host/ai-workspace-knowledge.js';
import { parseAiWorkspacePassages } from '../src/host/ai-wire-policy.js';

const workspace = (n: number, text = `note ${n}`) => ({
  uri: `knowledge://local/ws-1/notes/${n}.md#line=1-3`,
  title: `Note ${n}`,
  text,
});

describe('workspace passages in knowledge retrieval', () => {
  it('reports every workspace passage Gezel returns under one source', () => {
    const catalog = {
      n: 1,
      uri: 'knowledge://bendyline/wiki/doc-1',
      title: 'Doc 1',
      text: 'curated',
      catalogId: 'wiki',
      version: '1',
    };
    // Gezel returns a chosen candidate under its collection, the reference's second segment.
    const note = { ...workspace(1), n: 2, catalogId: 'ws-1', version: 'local' };
    const reported = withWorkspaceCatalogId([catalog, note]);
    expect(reported).to.deep.equal([
      catalog,
      { ...note, catalogId: WORKSPACE_KNOWLEDGE_CATALOG_ID },
    ]);
    // A catalog passage keeps its catalog, even one that claims the workspace's id.
    const impostor = { ...catalog, catalogId: 'ws-1' };
    expect(withWorkspaceCatalogId([impostor])).to.deep.equal([impostor]);
  });

  it('names a note and its lines in the grammar Gezel accepts, and reads it back', () => {
    const uri = workspacePassageUri('ws-1', '/Garden notes/Ros\u0065\u0301s.md', 3, 9);
    // NFC, no leading slash, each segment encoded.
    expect(uri).to.equal('knowledge://local/ws-1/Garden%20notes/Ros%C3%A9s.md#line=3-9');
    expect(parseWorkspacePassageUri(uri!)).to.deep.equal({
      catalogId: 'ws-1',
      path: 'Garden notes/Ros\u00e9s.md',
      lineStart: 3,
      lineEnd: 9,
    });
    expect(parseWorkspacePassageUri('knowledge://local/ws-1/a.md#line=4')).to.include({
      lineStart: 4,
      lineEnd: 4,
    });
    for (const path of [`${'x'.repeat(257)}.md`, 'a//b.md', ' a.md', 'a\u0007.md', '']) {
      expect(workspacePassageUri('ws-1', path, 1, 1), path).to.equal(null);
    }
    expect(workspacePassageUri('Not A Label', 'a.md', 1, 1)).to.equal(null);
    for (const bad of [
      'knowledge://bendyline/wiki/doc',
      'knowledge://local/ws-1/',
      'knowledge://local/ws-1/a%ZZ.md',
      'knowledge://local/ws-1/a.md#chunk=1',
      'knowledge://local/ws-1/a%2F%2Fb.md',
    ]) {
      expect(parseWorkspacePassageUri(bad), bad).to.equal(null);
    }
  });

  it('accepts only bounded knowledge://local passages on the wire', () => {
    expect(parseAiWorkspacePassages([workspace(1)])).to.deep.equal([workspace(1)]);
    expect(
      parseAiWorkspacePassages([{ ...workspace(1), uri: 'knowledge://bendyline/x/y' }]),
    ).to.equal(null);
    expect(parseAiWorkspacePassages([{ ...workspace(1), uri: 'https://example.com' }])).to.equal(
      null,
    );
    expect(parseAiWorkspacePassages([{ ...workspace(1), extra: 1 }])).to.equal(null);
    expect(parseAiWorkspacePassages(Array.from({ length: 7 }, (_, n) => workspace(n)))).to.equal(
      null,
    );
    expect(
      parseAiWorkspacePassages(
        Array.from({ length: 4 }, (_, n) => workspace(n, 'z'.repeat(3_500))),
      ),
    ).to.equal(null);
  });
});
