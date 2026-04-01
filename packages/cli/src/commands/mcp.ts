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
  .action(async () => {
    const { createMcpServer } = await import('../mcp/server.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });
