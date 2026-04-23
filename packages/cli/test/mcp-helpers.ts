import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';

export interface McpHarness {
  client: Client;
  tmpDir: string;
  dispose: () => Promise<void>;
}

export async function startMcpHarness(): Promise<McpHarness> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docblocks-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tmpDir = await mkdtemp(join(tmpdir(), 'docblocks-mcp-test-'));

  return {
    client,
    tmpDir,
    dispose: async () => {
      await client.close();
      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return {
    text: first && first.type === 'text' ? (first.text ?? '') : '',
    isError: Boolean((result as { isError?: boolean }).isError),
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
