import { expect } from 'chai';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  parseConversionResult,
  parseInspectionResult,
  parseMcpErrorResult,
  parseValidationResult,
} from '@bendyline/docblocks/mcp';
import { callTool } from './mcp-helpers.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

interface CliStdioHarness {
  client: Client;
  transport: StdioClientTransport;
  close: () => Promise<void>;
}

describe('MCP CLI stdio transport', function () {
  this.timeout(20_000);

  let root = '';
  let readRoot = '';
  let writeRoot = '';
  let outsideRoot = '';
  let artifactTempRoot = '';
  let h: CliStdioHarness | null = null;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'docblocks-mcp-stdio-'));
    readRoot = path.join(root, 'read');
    writeRoot = path.join(root, 'write');
    outsideRoot = path.join(root, 'outside');
    artifactTempRoot = path.join(root, 'temp');
    await Promise.all([
      mkdir(readRoot, { recursive: true }),
      mkdir(writeRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
      mkdir(artifactTempRoot, { recursive: true }),
    ]);

    h = await startCliStdio(
      [
        '--allow-read',
        readRoot,
        '--allow-write',
        writeRoot,
        '--max-concurrency',
        '2',
        '--max-input-bytes',
        '8388608',
        '--max-artifact-bytes',
        '8388608',
        '--max-artifact-total-bytes',
        '33554432',
        '--max-artifacts',
        '32',
        '--artifact-ttl-ms',
        '600000',
        '--max-resource-bytes',
        '8388608',
        '--max-report-bytes',
        '1048576',
        '--max-report-total-bytes',
        '4194304',
      ],
      artifactTempRoot,
    );
  });

  after(async () => {
    await h?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('connects, pings, and lists tools through the real CLI process', async () => {
    const cli = requireHarness(h);
    expect(cli.transport.pid).to.be.a('number').and.greaterThan(0);
    expect(cli.client.getServerVersion()?.name).to.equal('docblocks');

    await cli.client.ping();
    const { tools } = await cli.client.listTools();
    expect(tools.map((tool) => tool.name)).to.include.members([
      'convert_document',
      'inspect_document',
      'list_formats',
      'list_transform_styles',
    ]);
  });

  it('inspects canonical inline Markdown over stdio', async () => {
    const result = await callTool(requireHarness(h).client, 'inspect_document', {
      source: {
        kind: 'markdown',
        markdown: '# Stdio document\n\nA canonical markdown source.',
        name: null,
      },
    });

    expect(result.isError).to.equal(false);
    const inspection = parseInspectionResult(result.structuredContent);
    expect(inspection).to.not.equal(null);
    expect(inspection?.outline[0]?.title).to.equal('Stdio document');
    expect(inspection?.statistics.wordCount).to.be.greaterThan(0);
  });

  it('applies --allow-read to file sources without granting sibling paths', async () => {
    const allowedInput = path.join(readRoot, 'allowed.md');
    const deniedInput = path.join(outsideRoot, 'denied.md');
    await writeFile(allowedInput, '# Allowed\n\nReadable through the CLI flag.', 'utf8');
    await writeFile(deniedInput, '# Denied\n\nThis sibling is not authorized.', 'utf8');

    const cli = requireHarness(h).client;
    const roots = await callTool(cli, 'list_roots', {});
    const rootEntries = roots.structuredContent?.roots;
    expect(rootEntries).to.be.an('array');
    if (!Array.isArray(rootEntries)) throw new Error('Expected MCP root aliases');
    const readable = rootEntries.find((entry) => isRecord(entry) && entry.read === true);
    if (!isRecord(readable) || typeof readable.id !== 'string') {
      throw new Error('Expected one readable root alias');
    }
    expect(
      rootEntries.some((entry) => isRecord(entry) && entry.label === path.basename(outsideRoot)),
    ).to.equal(false);

    const allowed = await callTool(cli, 'inspect_document', {
      source: { kind: 'file', rootId: readable.id, path: 'allowed.md', format: 'md' },
    });
    expect(allowed.isError).to.equal(false);
    expect(parseInspectionResult(allowed.structuredContent)?.outline[0]?.title).to.equal('Allowed');

    const denied = await callTool(cli, 'inspect_document', {
      source: { kind: 'file', rootId: readable.id, path: '../outside/denied.md', format: 'md' },
    });
    expect(denied.isError).to.equal(true);
    expect(denied.text).to.include('Invalid arguments');
  });

  it('applies --allow-write only through an opaque destination alias', async () => {
    const cli = requireHarness(h);
    const converted = await callTool(cli.client, 'convert_document', {
      source: { kind: 'markdown', markdown: '# Writable', name: 'allowed.md' },
      targets: [{ format: 'md', fidelity: 'semantic' }],
    });
    expect(converted.isError, converted.text).to.equal(false);
    const raw = converted.structuredContent?.results;
    if (!Array.isArray(raw)) throw new Error('Expected conversion result');
    const artifact = parseConversionResult(raw[0])?.artifact;
    if (!artifact) throw new Error('Expected converted artifact');
    const roots = await callTool(cli.client, 'list_roots', {});
    const entries = roots.structuredContent?.roots;
    if (!Array.isArray(entries)) throw new Error('Expected root aliases');
    const writable = entries.find((entry) => isRecord(entry) && entry.write === true);
    if (!isRecord(writable) || typeof writable.id !== 'string') {
      throw new Error('Expected writable root alias');
    }
    const allowed = await callTool(cli.client, 'save_artifact', {
      artifactUri: artifact.uri,
      destination: {
        rootId: writable.id,
        path: 'allowed.md',
        ifExists: 'error',
        expectedSha256: null,
      },
    });
    expect(allowed.isError, allowed.text).to.equal(false);
    expect(await readFile(path.join(writeRoot, 'allowed.md'), 'utf8')).to.include('# Writable');

    const denied = await callTool(cli.client, 'save_artifact', {
      artifactUri: artifact.uri,
      destination: {
        rootId: 'root-not-granted',
        path: 'denied-output.md',
        ifExists: 'error',
        expectedSha256: null,
      },
    });
    expect(denied.isError).to.equal(true);
    expect(await stat(path.join(outsideRoot, 'denied-output.md')).catch(() => null)).to.equal(null);
  });

  it('runs convert -> resource -> inspect/validate -> save through real stdio', async () => {
    const cli = requireHarness(h);
    const markdown = '# Artifact workflow\n\nA complete agentic document pipeline.';
    const conversion = await cli.client.callTool({
      name: 'convert_document',
      arguments: {
        source: { kind: 'markdown', markdown, name: 'agentic-workflow.md' },
        targets: [{ format: 'md', fidelity: 'semantic' }],
      },
    });
    expect(conversion.isError).to.not.equal(true);
    const conversionEnvelope = requireRecord(
      conversion.structuredContent,
      'versioned MCP success envelope',
    );
    expect(conversionEnvelope).to.include({ version: 1, kind: 'success', error: null });
    const conversionPayload = requireRecord(conversionEnvelope.result, 'conversion payload');
    const results = conversionPayload.results;
    expect(results).to.be.an('array').with.length(1);
    if (!Array.isArray(results)) throw new Error('Expected one structured conversion result');
    const converted = parseConversionResult(results[0]);
    expect(converted, 'canonical conversion result').to.not.equal(null);
    if (!converted) throw new Error('Expected a canonical conversion result');
    expect(converted).to.include({
      sourceFormat: 'md',
      targetFormat: 'md',
      fidelity: 'semantic',
    });
    expect(converted.artifact).to.include({
      format: 'md',
      mimeType: 'text/markdown',
      suggestedFilename: 'agentic-workflow.md',
    });
    const conversionText = conversion.content.find((item) => item.type === 'text');
    expect(conversionText, 'conversion text content').to.not.equal(undefined);
    if (!conversionText || conversionText.type !== 'text') {
      throw new Error('Expected conversion text content');
    }
    expect(JSON.parse(conversionText.text)).to.deep.equal(conversionPayload);

    const links = conversion.content.filter((item) => item.type === 'resource_link');
    expect(links).to.have.length(1);
    expect(links[0]).to.include({
      type: 'resource_link',
      uri: converted.artifact.uri,
      name: converted.artifact.suggestedFilename,
      mimeType: converted.artifact.mimeType,
      size: converted.artifact.size,
    });

    const resource = await cli.client.readResource({ uri: converted.artifact.uri });
    expect(resource.contents).to.have.length(1);
    const artifactContent = resource.contents[0];
    expect(artifactContent).to.include({
      uri: converted.artifact.uri,
      mimeType: 'text/markdown',
    });
    if (!artifactContent || !('text' in artifactContent)) {
      throw new Error('Expected Markdown artifact text resource');
    }
    const artifactText = artifactContent.text;
    expect(artifactText.trimEnd()).to.equal(markdown);
    expect(Buffer.byteLength(artifactText, 'utf8')).to.equal(converted.artifact.size);

    const inspected = await callTool(cli.client, 'inspect_document', {
      source: { kind: 'artifact', uri: converted.artifact.uri },
    });
    expect(inspected.isError).to.equal(false);
    const inspection = parseInspectionResult(inspected.structuredContent);
    expect(inspection, 'canonical inspection result').to.not.equal(null);
    expect(inspection?.statistics.blockCount).to.be.greaterThan(0);
    expect(inspection?.outline[0]?.title).to.equal('Artifact workflow');

    const validated = await callTool(cli.client, 'validate_document', {
      source: { kind: 'artifact', uri: converted.artifact.uri },
      targetFormat: 'pdf',
    });
    expect(validated.isError).to.equal(false);
    const validation = parseValidationResult(validated.structuredContent);
    expect(validation, 'canonical validation result').to.not.equal(null);
    expect(validation).to.include({ sourceFormat: 'md', targetFormat: 'pdf', valid: true });

    const roots = await callTool(cli.client, 'list_roots', {});
    expect(roots.isError).to.equal(false);
    const rootEntries = roots.structuredContent?.roots;
    expect(rootEntries).to.be.an('array');
    if (!Array.isArray(rootEntries)) throw new Error('Expected MCP root descriptors');
    const writableRoot = rootEntries.find(
      (entry) => isRecord(entry) && entry.write === true && entry.read === false,
    );
    expect(writableRoot, 'write-root alias').to.not.equal(undefined);
    if (!isRecord(writableRoot) || typeof writableRoot.id !== 'string') {
      throw new Error('Expected one opaque write-root alias');
    }

    const destination = {
      rootId: writableRoot.id,
      path: 'agentic-workflow.md',
      ifExists: 'error',
      expectedSha256: null,
    };
    const saved = await callTool(cli.client, 'save_artifact', {
      artifactUri: converted.artifact.uri,
      destination,
    });
    expect(saved.isError).to.equal(false);
    expect(saved.structuredContent).to.deep.include({
      artifact: converted.artifact,
      destination: { rootId: writableRoot.id, path: destination.path },
      sha256: converted.artifact.sha256,
    });
    expect(JSON.stringify(saved.structuredContent)).not.to.include(writeRoot);
    expect(await readFile(path.join(writeRoot, destination.path), 'utf8')).to.equal(artifactText);

    const conflict = await callTool(cli.client, 'save_artifact', {
      artifactUri: converted.artifact.uri,
      destination,
    });
    expect(conflict.isError).to.equal(true);
    const parsedError = parseMcpErrorResult(conflict.structuredContent);
    expect(parsedError, 'canonical MCP error result').to.not.equal(null);
    if (!parsedError) throw new Error('Expected canonical MCP error result');
    const errorEnvelope: unknown = JSON.parse(conflict.text);
    expect(errorEnvelope).to.deep.equal(conflict.structuredContent);
    expect(parsedError.error).to.include({
      code: 'conflict',
      stage: 'materialize',
      format: null,
      hint: null,
      retryable: false,
    });
    expect(parsedError.error.message).to.include('already exists');
    expect(JSON.stringify(parsedError)).not.to.include(writeRoot);
  });

  it('awaits server cleanup and removes isolated artifact storage on client EOF', async () => {
    const cli = requireHarness(h);
    expect(cli.transport.pid).to.be.a('number').and.greaterThan(0);
    expect(await artifactDirectories(artifactTempRoot)).to.have.length(1);

    await cli.close();

    expect(cli.transport.pid).to.equal(null);
    expect(await artifactDirectories(artifactTempRoot)).to.deep.equal([]);
  });
});

async function startCliStdio(
  cliArguments: string[],
  tempDirectory?: string,
): Promise<CliStdioHarness> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', CLI_ENTRY, 'mcp', ...cliArguments],
    cwd: REPOSITORY_ROOT,
    stderr: 'pipe',
    ...(tempDirectory
      ? { env: { TEMP: tempDirectory, TMP: tempDirectory, TMPDIR: tempDirectory } }
      : {}),
  });
  let stderr = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const client = new Client({ name: 'docblocks-stdio-test', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (caught: unknown) {
    await transport.close();
    const reason = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`Failed to start DocBlocks MCP CLI: ${reason}\n${stderr}`);
  }

  let closed = false;
  return {
    client,
    transport,
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
    },
  };
}

async function artifactDirectories(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('docblocks-mcp-artifacts-'))
    .map((entry) => entry.name)
    .sort();
}

function requireHarness(value: CliStdioHarness | null): CliStdioHarness {
  if (!value) throw new Error('MCP CLI harness was not initialized');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${label}`);
  return value;
}
