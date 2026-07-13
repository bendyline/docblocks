import { expect } from 'chai';
import { MCP_WIRE_LIMITS, parseConversionResult } from '@bendyline/docblocks/mcp';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import {
  convertPreparedDocument,
  type ConversionServiceDependencies,
} from '../src/mcp/conversion-service.js';
import { DocumentService } from '../src/mcp/document-service.js';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

describe('MCP linked conversion warning projection', () => {
  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  it('retains target-specific CSV and XLSX fidelity warnings as structured diagnostics', async () => {
    const result = await callTool(harness.client, 'convert_document', {
      source: {
        kind: 'markdown',
        name: 'tables.md',
        markdown:
          '# Tables\n\nIntroductory prose is not tabular.\n\n' +
          '| A | B |\n| --- | --- |\n| one | two |\n\n' +
          '| C | D |\n| --- | --- |\n| three | four |',
      },
      targets: [{ format: 'csv' }, { format: 'xlsx' }],
    });

    expect(result.isError, result.text).to.equal(false);
    const payload = result.structuredContent as {
      results: Array<{
        targetFormat: string;
        diagnostics: Array<{
          code: string;
          severity: string;
          stage: string;
          format: string | null;
          message: string;
        }>;
      }>;
    };
    const csv = payload.results.find((entry) => entry.targetFormat === 'csv');
    const xlsx = payload.results.find((entry) => entry.targetFormat === 'xlsx');
    expect(csv).to.not.equal(undefined);
    expect(xlsx).to.not.equal(undefined);

    expect(
      csv!.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'csv-table-selection' &&
          diagnostic.severity === 'warning' &&
          diagnostic.stage === 'convert' &&
          diagnostic.format === 'csv',
      ),
    ).to.equal(true);
    expect(csv!.diagnostics.map(({ message }) => message).join('\n')).to.include(
      'CSV export emitted only the first',
    );
    expect(
      xlsx!.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'xlsx-content-omitted' &&
          diagnostic.severity === 'warning' &&
          diagnostic.stage === 'convert' &&
          diagnostic.format === 'xlsx',
      ),
    ).to.equal(true);
    expect(xlsx!.diagnostics.map(({ message }) => message).join('\n')).to.include(
      'XLSX export is tables-only',
    );
  });

  it('bounds and sanitizes linked warning diagnostics before publishing a conversion', async () => {
    const artifacts = new ArtifactStore();
    try {
      const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
      const prepared = await documents.prepare({
        kind: 'markdown',
        markdown: '# Linked warnings',
        name: null,
      });
      const warnings = Array.from(
        { length: MCP_WIRE_LIMITS.arrayEntries + 5 },
        (_unused, index) =>
          `warning-${index}\u007f${'X'.repeat(MCP_WIRE_LIMITS.messageCharacters + 20)}`,
      );
      const dependencies: ConversionServiceDependencies = {
        prepareNativeConversion: async () => ({
          convert: async () => ({
            bytes: new TextEncoder().encode('# Converted'),
            mimeType: 'text/markdown',
            suggestedFilename: 'converted.md',
            warnings,
          }),
        }),
        convertRenderedDocument: async () => {
          throw new Error('Rendered conversion was not expected');
        },
      };

      const [result] = await convertPreparedDocument(
        artifacts,
        prepared,
        { targets: [{ format: 'md', fidelity: 'semantic' }] },
        undefined,
        undefined,
        dependencies,
      );
      expect(result).to.not.equal(undefined);
      expect(parseConversionResult(result)).to.not.equal(null);
      expect(result!.diagnostics.length).to.be.at.most(MCP_WIRE_LIMITS.arrayEntries);
      expect(
        result!.diagnostics.every(
          ({ message }) =>
            message.length <= MCP_WIRE_LIMITS.messageCharacters && !message.includes('\u007f'),
        ),
      ).to.equal(true);
      expect(result!.diagnostics.some(({ code }) => code === 'diagnostics-truncated')).to.equal(
        true,
      );
    } finally {
      await artifacts.dispose();
    }
  });
});
