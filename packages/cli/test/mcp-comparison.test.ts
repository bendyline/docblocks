import { expect } from 'chai';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import { DocumentService } from '../src/mcp/document-service.js';
import { comparePreparedDocuments } from '../src/mcp/intelligence.js';

describe('MCP semantic and media comparison', () => {
  let artifacts: ArtifactStore;

  beforeEach(() => {
    artifacts = new ArtifactStore({
      maxArtifactBytes: 1_024,
      maxArtifactTotalBytes: 8_192,
      maxArtifactCount: 8,
      artifactTtlMs: 5_000,
    });
  });

  afterEach(async () => artifacts.dispose());

  it('reports retained, changed, and omitted layout, timing, and accessibility evidence', async () => {
    const authority = await McpFileAuthority.create();
    const documents = new DocumentService(authority, artifacts);
    const left = await documents.prepare({
      kind: 'markdown',
      markdown: [
        '---',
        'title: Original',
        'squisq-theme: documentary',
        '---',
        '',
        '# Visual {[photGrid]}',
        '',
        'Alpha content with ![Meaningful alt](image.png).',
      ].join('\n'),
      name: 'left.md',
    });
    left.doc.duration = 12;
    left.doc.audio = {
      segments: [{ src: 'audio/narration.mp3', name: 'narration', duration: 12, startTime: 0 }],
    };
    left.doc.captions = {
      version: 1,
      phrases: [
        {
          text: 'Alpha content',
          startTime: 0,
          endTime: 2,
          audioSegment: 0,
        },
      ],
    };

    const right = await documents.prepare({
      kind: 'markdown',
      markdown: '# Visual\n\nDifferent content with ![](image.png).',
      name: 'right.md',
    });

    const result = await comparePreparedDocuments(documents, left, right);

    expect(result.equivalent).to.equal(false);
    expect(result.score).to.be.lessThan(1);
    expect(result.changes.map((change) => change.category)).to.have.members([
      'text',
      'structure',
      'table',
      'media',
      'theme',
      'layout',
      'metadata',
      'timing',
      'accessibility',
    ]);
    expect(result.changes.find((change) => change.category === 'layout')?.status).to.equal(
      'changed',
    );
    expect(result.changes.find((change) => change.category === 'timing')?.status).to.equal(
      'omitted',
    );
    expect(result.changes.find((change) => change.category === 'accessibility')?.status).to.equal(
      'changed',
    );
    expect(result.metrics.map((metric) => metric.name)).to.include.members([
      'layouts',
      'durationSeconds',
      'accessibilityFeatures',
    ]);
  });

  it('returns explicit retained evidence for equivalent documents', async () => {
    const authority = await McpFileAuthority.create();
    const documents = new DocumentService(authority, artifacts);
    const prepared = await documents.prepare({
      kind: 'markdown',
      markdown: '# Same\n\nContent',
      name: 'same.md',
    });

    const result = await comparePreparedDocuments(documents, prepared, prepared);

    expect(result).to.include({ equivalent: true, score: 1 });
    expect(result.changes).to.have.length(9);
    expect(result.changes.every((change) => change.status === 'retained')).to.equal(true);
  });

  it('includes descendant text in word metrics for hierarchical documents', async () => {
    const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
    const left = await documents.prepare({
      kind: 'markdown',
      markdown: '# Parent\n\nShort parent text.\n\n## Child\n\n| Value |\n| --- |\n| same |',
      name: null,
    });
    const right = await documents.prepare({
      kind: 'markdown',
      markdown:
        '# Parent\n\nMuch longer parent text with additional meaningful words.\n\n## Child\n\n| Value |\n| --- |\n| same |',
      name: null,
    });

    const result = await comparePreparedDocuments(documents, left, right);
    const words = result.metrics.find((metric) => metric.name === 'words');
    const blocks = result.metrics.find((metric) => metric.name === 'blocks');

    expect(words?.leftValue).to.be.greaterThan(1);
    expect(words?.rightValue).to.be.greaterThan(words?.leftValue ?? 0);
    expect(blocks).to.include({ leftValue: 2, rightValue: 2 });
  });

  it('compares semantic content beyond the bounded inspection page', async () => {
    const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
    const prefix = Array.from(
      { length: 2_000 },
      (_unused, index) => `## Shared ${index}\n\nShared body ${index}.`,
    ).join('\n\n');
    const left = await documents.prepare({
      kind: 'markdown',
      markdown: `${prefix}\n\n## Tail\n\nAlpha-only final evidence.`,
      name: 'left-long.md',
    });
    const right = await documents.prepare({
      kind: 'markdown',
      markdown: `${prefix}\n\n## Tail\n\nBeta-only final evidence.`,
      name: 'right-long.md',
    });

    const result = await comparePreparedDocuments(documents, left, right);

    expect(result.equivalent).to.equal(false);
    expect(result.score).to.be.lessThan(1);
    expect(result.changes.find((change) => change.category === 'text')?.status).to.equal(
      'degraded',
    );
  });
});
