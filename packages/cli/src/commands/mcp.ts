/**
 * mcp command — start the DocBlocks MCP server over stdio.
 *
 * Usage:
 *   docblocks mcp
 *
 * For Claude Desktop, add to your config:
 *   { "mcpServers": { "docblocks": { "command": "npx", "args": ["-y", "@bendyline/docblocks-cli", "mcp"] } } }
 */

import process from 'node:process';
import { Command } from 'commander';
import { MCP_ARTIFACT_STORE_LIMITS } from '../mcp/artifact-store.js';
import { MCP_FILE_AUTHORITY_LIMITS } from '../mcp/authority.js';

export const mcpCommand = new Command('mcp')
  .description('Start an MCP server over stdio for AI-assisted document operations')
  .option('--allow-read <dir...>', 'allow MCP tools to read below these directories')
  .option('--allow-write <dir...>', 'allow MCP tools to write below these directories')
  .option('--max-concurrency <count>', 'maximum simultaneous expensive tools', '2')
  .option(
    '--operation-timeout-ms <milliseconds>',
    'runtime budget for one expensive tool',
    '120000',
  )
  .option(
    '--max-input-bytes <bytes>',
    'maximum bytes read from one granted source file',
    '104857600',
  )
  .option('--max-artifact-bytes <bytes>', 'maximum bytes in one generated artifact', '524288000')
  .option(
    '--max-artifact-total-bytes <bytes>',
    'maximum generated artifact bytes per session',
    '1073741824',
  )
  .option('--max-artifacts <count>', 'maximum generated artifacts per session', '64')
  .option('--artifact-ttl-ms <milliseconds>', 'generated artifact lifetime', '1800000')
  .option(
    '--max-resource-bytes <bytes>',
    'maximum artifact bytes returned as an MCP resource',
    '26214400',
  )
  .option('--max-report-bytes <bytes>', 'maximum stored conversion report bytes', '8388608')
  .option(
    '--max-report-total-bytes <bytes>',
    'maximum stored conversion report bytes per session',
    '67108864',
  )
  .action(
    async (opts: {
      allowRead?: string[];
      allowWrite?: string[];
      maxConcurrency: string;
      operationTimeoutMs: string;
      maxInputBytes: string;
      maxArtifactBytes: string;
      maxArtifactTotalBytes: string;
      maxArtifacts: string;
      artifactTtlMs: string;
      maxResourceBytes: string;
      maxReportBytes: string;
      maxReportTotalBytes: string;
    }) => {
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
      const operationTimeoutMs = Number(opts.operationTimeoutMs);
      if (
        !Number.isSafeInteger(operationTimeoutMs) ||
        operationTimeoutMs < 1_000 ||
        operationTimeoutMs > 30 * 60 * 1_000
      ) {
        throw new Error('--operation-timeout-ms must be between 1000 and 1800000');
      }
      const server = createMcpServer({
        readRoots: opts.allowRead ?? [],
        writeRoots: opts.allowWrite ?? [],
        maxConcurrentOperations,
        operationTimeoutMs,
        maxInputFileBytes: boundedIntegerOption(
          '--max-input-bytes',
          opts.maxInputBytes,
          MCP_FILE_AUTHORITY_LIMITS.maxInputFileBytes,
        ),
        maxArtifactBytes: boundedIntegerOption(
          '--max-artifact-bytes',
          opts.maxArtifactBytes,
          MCP_ARTIFACT_STORE_LIMITS.maxArtifactBytes,
        ),
        maxArtifactTotalBytes: boundedIntegerOption(
          '--max-artifact-total-bytes',
          opts.maxArtifactTotalBytes,
          MCP_ARTIFACT_STORE_LIMITS.maxArtifactTotalBytes,
        ),
        maxArtifactCount: boundedIntegerOption(
          '--max-artifacts',
          opts.maxArtifacts,
          MCP_ARTIFACT_STORE_LIMITS.maxArtifactCount,
        ),
        artifactTtlMs: boundedIntegerOption(
          '--artifact-ttl-ms',
          opts.artifactTtlMs,
          MCP_ARTIFACT_STORE_LIMITS.artifactTtlMs,
        ),
        maxArtifactResourceBytes: boundedIntegerOption(
          '--max-resource-bytes',
          opts.maxResourceBytes,
          MCP_ARTIFACT_STORE_LIMITS.maxArtifactResourceBytes,
        ),
        maxArtifactReportBytes: boundedIntegerOption(
          '--max-report-bytes',
          opts.maxReportBytes,
          MCP_ARTIFACT_STORE_LIMITS.maxArtifactReportBytes,
        ),
        maxArtifactReportTotalBytes: boundedIntegerOption(
          '--max-report-total-bytes',
          opts.maxReportTotalBytes,
          MCP_ARTIFACT_STORE_LIMITS.maxArtifactReportTotalBytes,
        ),
      });
      const transport = new StdioServerTransport();
      let markDisconnected: () => void = () => undefined;
      const disconnected = new Promise<void>((resolve) => {
        markDisconnected = resolve;
      });
      const onInputClosed = (): void => markDisconnected();
      let exitSignal: 'SIGINT' | 'SIGTERM' | null = null;
      const onSigint = (): void => {
        exitSignal = 'SIGINT';
        markDisconnected();
      };
      const onSigterm = (): void => {
        exitSignal = 'SIGTERM';
        markDisconnected();
      };
      const previousTransportClose = transport.onclose;
      transport.onclose = () => {
        previousTransportClose?.();
        markDisconnected();
      };
      process.stdin.once('end', onInputClosed);
      process.stdin.once('close', onInputClosed);
      process.once('SIGINT', onSigint);
      process.once('SIGTERM', onSigterm);
      try {
        await server.connect(transport);
        if (process.stdin.readableEnded || process.stdin.destroyed) markDisconnected();
        await disconnected;
      } finally {
        process.stdin.off('end', onInputClosed);
        process.stdin.off('close', onInputClosed);
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        await server.close();
        if (exitSignal === 'SIGINT') process.exitCode = 130;
        if (exitSignal === 'SIGTERM') process.exitCode = 143;
      }
    },
  );

function boundedIntegerOption(name: string, value: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}
