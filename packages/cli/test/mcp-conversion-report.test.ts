import { expect } from 'chai';
import { parseConversionResult, parsePreviewResult } from '@bendyline/docblocks/mcp';
import { callTool, startMcpHarness } from './mcp-helpers.js';

describe('MCP persisted conversion reports and binary resources', () => {
  it('retrieves the original report by tool and report resource after conversion', async () => {
    const harness = await startMcpHarness();
    try {
      const converted = await callTool(harness.client, 'convert_document', {
        source: { kind: 'markdown', markdown: '# Durable report', name: 'report.md' },
        targets: [{ format: 'md', fidelity: 'semantic' }],
      });
      const results = converted.structuredContent?.results;
      expect(results).to.be.an('array').with.length(1);
      const original = parseConversionResult(Array.isArray(results) ? results[0] : null);
      expect(original).to.not.equal(null);
      if (!original) throw new Error('Expected a conversion result');

      const fetched = await callTool(harness.client, 'get_conversion_report', {
        artifactUri: original.artifact.uri,
      });
      expect(fetched.isError).to.equal(false);
      expect(parseConversionResult(fetched.structuredContent)).to.deep.equal(original);

      const resource = await harness.client.readResource({
        uri: `docblocks://reports/${original.artifact.id}`,
      });
      expect(resource.contents).to.have.length(1);
      const content = resource.contents[0];
      expect(content).to.include({
        uri: `docblocks://reports/${original.artifact.id}`,
        mimeType: 'application/json',
      });
      if (!content || !('text' in content)) throw new Error('Expected report text resource');
      expect(parseConversionResult(JSON.parse(content.text) as unknown)).to.deep.equal(original);

      const previewed = await callTool(harness.client, 'preview_document', {
        source: { kind: 'markdown', markdown: '# No report', name: 'preview.md' },
        maxItems: 1,
      });
      const preview = parsePreviewResult(previewed.structuredContent);
      expect(preview).to.not.equal(null);
      if (!preview) throw new Error('Expected preview result');
      const previewArtifact = preview.items[0]?.artifact;
      expect(previewArtifact).to.not.equal(undefined);
      if (!previewArtifact) throw new Error('Expected preview artifact');

      const completion = await harness.client.complete({
        ref: { type: 'ref/resource', uri: 'docblocks://reports/{id}' },
        argument: { name: 'id', value: '' },
      });
      expect(completion.completion.values).to.include(original.artifact.id);
      expect(completion.completion.values).not.to.include(previewArtifact.id);
    } finally {
      await harness.dispose();
    }
  });

  it('serves binary artifact resources with exact MIME and bytes', async () => {
    const harness = await startMcpHarness();
    try {
      const converted = await callTool(harness.client, 'convert_document', {
        source: { kind: 'markdown', markdown: '# Binary PDF\n\nExact bytes.', name: 'binary.md' },
        targets: [{ format: 'pdf', fidelity: 'semantic' }],
      });
      const results = converted.structuredContent?.results;
      const report = parseConversionResult(Array.isArray(results) ? results[0] : null);
      expect(report).to.not.equal(null);
      if (!report) throw new Error('Expected PDF conversion result');

      const resource = await harness.client.readResource({ uri: report.artifact.uri });
      const content = resource.contents[0];
      expect(content).to.include({ uri: report.artifact.uri, mimeType: 'application/pdf' });
      if (!content || !('blob' in content)) throw new Error('Expected binary artifact blob');
      const bytes = Buffer.from(content.blob, 'base64');
      expect(bytes.byteLength).to.equal(report.artifact.size);
      expect(bytes.subarray(0, 5).toString('ascii')).to.equal('%PDF-');
    } finally {
      await harness.dispose();
    }
  });
});
