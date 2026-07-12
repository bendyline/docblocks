import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type McpServerOptions } from '../src/mcp/server.js';

export interface McpHarness {
  client: Client;
  tmpDir: string;
  dispose: () => Promise<void>;
}

export async function startMcpHarness(options: McpServerOptions = {}): Promise<McpHarness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'docblocks-mcp-test-'));
  const server = createMcpServer({
    readRoots: [tmpDir],
    writeRoots: [tmpDir],
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docblocks-test', version: '0.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  } catch (caught: unknown) {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true });
    throw caught;
  }

  let disposed = false;
  return {
    client,
    tmpDir,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await client.close();
      } finally {
        await server.close().catch(() => undefined);
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  text: string;
  isError: boolean;
  structuredContent: Record<string, unknown> | undefined;
}> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return {
    text: first && first.type === 'text' ? (first.text ?? '') : '',
    isError: Boolean((result as { isError?: boolean }).isError),
    structuredContent: result.structuredContent,
  };
}

/** Fixture markdown used by most forward-direction tests. */
export const SAMPLE_MARKDOWN = `# Golden Gate Bridge

## Introduction

The Golden Gate Bridge is a suspension bridge spanning the Golden Gate strait.

## Key Facts

- Opened in 1937
- Length: 2,737 metres
- Clearance: 67 metres above water

## Legacy

It remains one of the most photographed bridges in the world.
`;
