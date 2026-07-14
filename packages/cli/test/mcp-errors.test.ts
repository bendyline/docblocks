import { expect } from 'chai';
import { MCP_WIRE_LIMITS, parseMcpErrorResult } from '@bendyline/docblocks/mcp';
import { errorResult } from '../src/mcp/error-result.js';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

describe('MCP structured failures', () => {
  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  it('returns an exact structured error envelope as well as text content', async () => {
    const result = await callTool(harness.client, 'describe_template', {
      templateId: 'not-a-real-template',
    });

    expect(result.isError).to.equal(true);
    const parsed = parseMcpErrorResult(result.structuredContent);
    expect(parsed, JSON.stringify(result)).to.not.equal(null);
    expect(parsed).to.deep.include({ version: 1, kind: 'error' });
    expect(parsed?.error).to.include({
      code: 'operation-failed',
      stage: 'validate',
      format: null,
      retryable: false,
    });
    expect(JSON.parse(result.text)).to.deep.equal(parsed);
  });

  it('uses versioned canonical success and conversion error contracts', async () => {
    const inspected = await callTool(harness.client, 'inspect_document', {
      source: { kind: 'markdown', markdown: '# Versioned\n\nContent', name: null },
    });
    expect(inspected.isError).to.equal(false);
    expect(inspected.structuredContent).to.deep.include({ version: 1, kind: 'inspection' });

    const rejected = await callTool(harness.client, 'convert_document', {
      source: { kind: 'markdown', markdown: '# Invalid style', name: null },
      transformId: 'not-a-real-style',
      targets: [{ format: 'dbk', fidelity: 'semantic' }],
    });
    expect(rejected.isError).to.equal(true);
    const parsed = parseMcpErrorResult(rejected.structuredContent);
    expect(parsed?.error).to.include({
      stage: 'convert',
      retryable: false,
    });
  });

  it('sanitizes and bounds untrusted error messages and hints before publication', () => {
    const failure = Object.assign(
      new Error(`linked\0message\u007f${'x'.repeat(MCP_WIRE_LIMITS.messageCharacters + 100)}`),
      {
        hint: `retry\u007fwithout\0controls${'y'.repeat(MCP_WIRE_LIMITS.messageCharacters + 100)}`,
      },
    );

    const result = errorResult(failure, 'convert');
    const parsed = parseMcpErrorResult(result.structuredContent);

    expect(parsed).to.not.equal(null);
    if (!parsed?.error.hint) throw new Error('Expected a canonical bounded error hint');
    expect(parsed.error.message.length).to.be.at.most(MCP_WIRE_LIMITS.messageCharacters);
    expect(parsed.error.hint.length).to.be.at.most(MCP_WIRE_LIMITS.messageCharacters);
    expect(parsed.error.message).to.include('\uFFFD');
    expect(parsed.error.hint).to.include('\uFFFD');
    expect(parsed.error.message.includes('\0')).to.equal(false);
    expect(parsed.error.message.includes('\u007f')).to.equal(false);
    expect(parsed.error.hint.includes('\0')).to.equal(false);
    expect(parsed.error.hint.includes('\u007f')).to.equal(false);
  });

  it('rejects control-bearing vocabulary ids at the protocol input boundary', async () => {
    const invalidCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      {
        name: 'convert_document',
        arguments: {
          source: { kind: 'markdown', markdown: '# Invalid theme', name: null },
          themeId: 'bad\0theme',
          targets: [{ format: 'md', fidelity: 'semantic' }],
        },
      },
      {
        name: 'convert_document',
        arguments: {
          source: { kind: 'markdown', markdown: '# Invalid transform', name: null },
          transformId: 'bad\u007ftransform',
          targets: [{ format: 'md', fidelity: 'semantic' }],
        },
      },
      { name: 'describe_theme', arguments: { themeId: 'bad\0theme' } },
      { name: 'describe_template', arguments: { templateId: 'bad\u007ftemplate' } },
    ];

    for (const request of invalidCalls) {
      const result = await callTool(harness.client, request.name, request.arguments);
      expect(result.isError, request.name).to.equal(true);
    }
  });
});
