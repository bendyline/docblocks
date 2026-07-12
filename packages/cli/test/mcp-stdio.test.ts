import { expect } from 'chai';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callTool } from './mcp-helpers.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

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
  let h: CliStdioHarness | null = null;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'docblocks-mcp-stdio-'));
    readRoot = path.join(root, 'read');
    writeRoot = path.join(root, 'write');
    outsideRoot = path.join(root, 'outside');
    await Promise.all([
      mkdir(readRoot, { recursive: true }),
      mkdir(writeRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
    ]);

    h = await startCliStdio([
      '--allow-read',
      readRoot,
      '--allow-write',
      writeRoot,
      '--max-concurrency',
      '2',
    ]);
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
      'analyze_markdown',
      'restyle_markdown',
      'list_transform_styles',
    ]);
  });

  it('analyzes canonical source.text input over stdio', async () => {
    const result = await callTool(requireHarness(h).client, 'analyze_markdown', {
      source: {
        kind: 'text',
        text: '# Stdio document\n\nA canonical markdown source.',
      },
    });

    expect(result.isError).to.equal(false);
    const payload = JSON.parse(result.text) as {
      stats: { headingCount: number; paragraphCount: number; wordCount: number };
    };
    expect(payload.stats.headingCount).to.equal(1);
    expect(payload.stats.paragraphCount).to.equal(1);
    expect(payload.stats.wordCount).to.be.greaterThan(0);
  });

  it('applies --allow-read to file sources without granting sibling paths', async () => {
    const allowedInput = path.join(readRoot, 'allowed.md');
    const deniedInput = path.join(outsideRoot, 'denied.md');
    await writeFile(allowedInput, '# Allowed\n\nReadable through the CLI flag.', 'utf8');
    await writeFile(deniedInput, '# Denied\n\nThis sibling is not authorized.', 'utf8');

    const allowed = await callTool(requireHarness(h).client, 'analyze_markdown', {
      source: { kind: 'file', path: allowedInput },
    });
    expect(allowed.isError).to.equal(false);
    expect(allowed.text).to.include('"headingCount": 1');

    const denied = await callTool(requireHarness(h).client, 'analyze_markdown', {
      source: { kind: 'file', path: deniedInput },
    });
    expect(denied.isError).to.equal(true);
    expect(denied.text.toLowerCase()).to.include('outside the configured roots');
  });

  it('applies --allow-write to output files without granting sibling paths', async () => {
    const cli = requireHarness(h);
    const listed = await callTool(cli.client, 'list_transform_styles', {});
    expect(listed.isError).to.equal(false);
    const styles = JSON.parse(listed.text) as Array<{ id?: unknown }>;
    const style = styles[0]?.id;
    expect(style).to.be.a('string');
    if (typeof style !== 'string') throw new Error('Expected at least one transform style');

    const allowedOutput = path.join(writeRoot, 'allowed.md');
    const allowed = await callTool(cli.client, 'restyle_markdown', {
      source: { kind: 'text', text: '# Writable\n\nContent for the allowed output.' },
      style,
      outputPath: allowedOutput,
    });
    expect(allowed.isError).to.equal(false);
    expect(await readFile(allowedOutput, 'utf8')).to.equal(allowed.text);

    const deniedOutput = path.join(outsideRoot, 'denied-output.md');
    const denied = await callTool(cli.client, 'restyle_markdown', {
      source: { kind: 'text', text: '# Not writable' },
      style,
      outputPath: deniedOutput,
    });
    expect(denied.isError).to.equal(true);
    expect(denied.text.toLowerCase()).to.include('outside the configured roots');
    expect(await stat(deniedOutput).catch(() => null)).to.equal(null);
  });

  it('closes the client and spawned CLI process cleanly', async () => {
    const cli = requireHarness(h);
    expect(cli.transport.pid).to.be.a('number').and.greaterThan(0);

    await cli.close();

    expect(cli.transport.pid).to.equal(null);
  });
});

async function startCliStdio(cliArguments: string[]): Promise<CliStdioHarness> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', CLI_ENTRY, 'mcp', ...cliArguments],
    cwd: REPOSITORY_ROOT,
    stderr: 'pipe',
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

function requireHarness(value: CliStdioHarness | null): CliStdioHarness {
  if (!value) throw new Error('MCP CLI harness was not initialized');
  return value;
}
