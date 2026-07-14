import { expect } from 'chai';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MCP_WIRE_LIMITS,
  parseInspectionResult,
  parseValidationResult,
  type McpDiagnostic,
} from '@bendyline/docblocks/mcp';
import { MCP_MAX_PUBLISHED_DIAGNOSTICS, boundDiagnostics } from '../src/mcp/intelligence.js';
import { callTool, startMcpHarness } from './mcp-helpers.js';

describe('MCP intelligence wire bounds', function () {
  this.timeout(20_000);

  it('bounds unique diagnostics with explicit severity-preserving aggregates', () => {
    const diagnostics: McpDiagnostic[] = Array.from(
      { length: MCP_MAX_PUBLISHED_DIAGNOSTICS + 5 },
      (_unused, index) => ({
        code: `issue-${index}`,
        severity: index % 3 === 0 ? 'error' : index % 3 === 1 ? 'warning' : 'info',
        stage: 'validate',
        format: 'md',
        count: 1,
        message: `Issue ${index}`,
        remediation: null,
        retryable: false,
        location: null,
      }),
    );
    const bounded = boundDiagnostics(diagnostics, 'validate');

    expect(bounded.length).to.equal(MCP_MAX_PUBLISHED_DIAGNOSTICS);
    const truncation = bounded.filter(({ code }) => code === 'diagnostics-truncated');
    expect(truncation.map(({ severity }) => severity)).to.have.members([
      'error',
      'warning',
      'info',
    ]);
    const countBySeverity = (entries: readonly McpDiagnostic[], severity: string) =>
      entries
        .filter((diagnostic) => diagnostic.severity === severity)
        .reduce((sum, diagnostic) => sum + diagnostic.count, 0);
    for (const severity of ['error', 'warning', 'info']) {
      expect(countBySeverity(bounded, severity), severity).to.equal(
        countBySeverity(diagnostics, severity),
      );
    }

    const summary = {
      errorCount: countBySeverity(bounded, 'error'),
      warningCount: countBySeverity(bounded, 'warning'),
      infoCount: countBySeverity(bounded, 'info'),
    };
    expect(
      parseValidationResult({
        version: 1,
        kind: 'validation',
        sourceFormat: 'md',
        targetFormat: null,
        valid: false,
        summary,
        diagnostics: bounded,
      }),
    ).to.not.equal(null);
  });

  it('normalizes validation targets and sums aggregated diagnostic counts', async () => {
    const harness = await startMcpHarness();
    try {
      const response = await callTool(harness.client, 'validate_document', {
        source: {
          kind: 'markdown',
          name: null,
          markdown: '# Accessibility\n\n![](one.png)\n\n![](two.png)',
        },
        targetFormat: 'PPTX',
      });
      expect(response.isError).to.equal(false);
      const validation = parseValidationResult(response.structuredContent);
      expect(validation).to.not.equal(null);
      expect(validation?.targetFormat).to.equal('pptx');
      expect(validation?.diagnostics.find(({ code }) => code === 'missing-alt-text')).to.include({
        count: 2,
        format: 'pptx',
      });
      expect(validation?.summary.warningCount).to.equal(
        validation?.diagnostics
          .filter(({ severity }) => severity === 'warning')
          .reduce((sum, diagnostic) => sum + diagnostic.count, 0),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('bounds frontmatter metadata before publishing an inspection result', async () => {
    const harness = await startMcpHarness();
    try {
      const title = 'T'.repeat(MCP_WIRE_LIMITS.labelCharacters + 200);
      const author = 'A'.repeat(MCP_WIRE_LIMITS.labelCharacters + 200);
      const description = 'D'.repeat(MCP_WIRE_LIMITS.messageCharacters + 200);
      const response = await callTool(harness.client, 'inspect_document', {
        source: {
          kind: 'markdown',
          name: null,
          markdown: `---\ntitle: ${title}\nauthor: ${author}\ndescription: ${description}\n---\n\n# Report`,
        },
      });
      expect(response.isError).to.equal(false);
      const inspection = parseInspectionResult(response.structuredContent);
      expect(inspection).to.not.equal(null);
      expect(inspection?.metadata.title).to.have.length(MCP_WIRE_LIMITS.labelCharacters);
      expect(inspection?.metadata.author).to.have.length(MCP_WIRE_LIMITS.labelCharacters);
      expect(inspection?.metadata.description).to.have.length(MCP_WIRE_LIMITS.messageCharacters);
    } finally {
      await harness.dispose();
    }
  });

  it('bounds and sanitizes table and link text imported from a file', async () => {
    const harness = await startMcpHarness();
    try {
      const unsafeLabel = `Heading\u007f${'X'.repeat(MCP_WIRE_LIMITS.labelCharacters + 200)}`;
      await writeFile(
        join(harness.tmpDir, 'wire-text.md'),
        `# Bounds\n\n| ${unsafeLabel} |\n| --- |\n| Value |\n\n[${unsafeLabel}](https://example.com)`,
        'utf8',
      );
      const roots = await callTool(harness.client, 'list_roots', {});
      const rootValues = roots.structuredContent?.roots;
      if (!Array.isArray(rootValues)) throw new Error('Expected readable roots');
      const root = rootValues.find(
        (value): value is { id: string; read: true } =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { id?: unknown }).id === 'string' &&
          (value as { read?: unknown }).read === true,
      );
      if (!root) throw new Error('Expected a readable root');

      const response = await callTool(harness.client, 'inspect_document', {
        source: { kind: 'file', rootId: root.id, path: 'wire-text.md', format: 'md' },
      });
      expect(response.isError, response.text).to.equal(false);
      const inspection = parseInspectionResult(response.structuredContent);
      expect(inspection).to.not.equal(null);
      const header = inspection?.tables[0]?.headers[0];
      const linkText = inspection?.links[0]?.text;
      expect(header).to.have.length(MCP_WIRE_LIMITS.labelCharacters);
      expect(linkText).to.have.length(MCP_WIRE_LIMITS.labelCharacters);
      expect(header).to.not.include('\u007f');
      expect(linkText).to.not.include('\u007f');
    } finally {
      await harness.dispose();
    }
  });
});
