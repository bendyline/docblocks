/**
 * mcp command — start the DocBlocks MCP server over stdio.
 *
 * Usage:
 *   docblocks mcp
 *
 * For Claude Desktop, add to your config:
 *   { "mcpServers": { "docblocks": { "command": "npx", "args": ["docblocks", "mcp"] } } }
 */

import { Command } from 'commander';

export const mcpCommand = new Command('mcp')
  .description('Start an MCP server over stdio for AI-assisted document operations')
  .option('--allow-read <dir...>', 'allow MCP tools to read below these directories')
  .option('--allow-write <dir...>', 'allow MCP tools to write below these directories')
  .option('--max-concurrency <count>', 'maximum simultaneous expensive tools', '2')
  .action(async (opts: { allowRead?: string[]; allowWrite?: string[]; maxConcurrency: string }) => {
    const { createMcpServer } = await import('../mcp/server.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

    const maxConcurrentOperations = Number(opts.maxConcurrency);
    if (
      !Number.isSafeInteger(maxConcurrentOperations) ||
      maxConcurrentOperations < 1 ||
      maxConcurrentOperations > 32
    ) {
      throw new Error('--max-concurrency must be an integer between 1 and 32');
    }
    const server = createMcpServer({
      readRoots: opts.allowRead ?? [],
      writeRoots: opts.allowWrite ?? [],
      maxConcurrentOperations,
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });
