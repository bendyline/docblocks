import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_WIRE_LIMITS } from '@bendyline/docblocks/mcp';
import { MCP_FORMAT_CAPABILITIES } from './conversion-service.js';
import { errorResult, successResult } from './error-result.js';
import { DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS } from '@bendyline/docblocks/mcp/zod';
import {
  MCP_OUTPUT_PATTERNS,
  boundWireText,
  boundWireTextArray,
  requireWireIdentifier,
} from './output-bounds.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Register the canonical linked-registry discovery surface (no format-specific aliases). */
export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    'list_formats',
    {
      description:
        'List every format in the linked Squisq registry and whether DocBlocks can import it through document tools or export it through convert_document.',
      inputSchema: z.object({}).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.list_formats,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const result = { formats: serializableCapabilities() };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: successResult(result),
        };
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect');
      }
    },
  );

  server.registerTool(
    'list_themes',
    {
      description: 'List the linked Squisq built-in visual themes.',
      inputSchema: z.object({}).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.list_themes,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const { getThemeSummaries } = await import('@bendyline/squisq/schemas');
        const result = {
          themes: getThemeSummaries()
            .slice(0, MCP_WIRE_LIMITS.arrayEntries)
            .map((theme) => ({
              id: requireWireIdentifier(theme.id, 'theme id'),
              name: boundWireText(theme.name, MCP_WIRE_LIMITS.labelCharacters, theme.id),
              description: boundWireText(theme.description ?? ''),
            })),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: successResult(result),
        };
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect');
      }
    },
  );

  server.registerTool(
    'list_transform_styles',
    {
      description: 'List the linked Squisq transform styles accepted by convert_document.',
      inputSchema: z.object({}).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.list_transform_styles,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const { getTransformStyleSummaries } = await import('@bendyline/squisq/transform');
        const result = {
          styles: getTransformStyleSummaries()
            .slice(0, MCP_WIRE_LIMITS.arrayEntries)
            .map((style) => ({
              id: requireWireIdentifier(style.id, 'transform style id'),
              name: boundWireText(style.name, MCP_WIRE_LIMITS.labelCharacters, style.id),
              description: boundWireText(style.description),
            })),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: successResult(result),
        };
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect');
      }
    },
  );

  server.registerResource(
    'formats',
    'docblocks://formats',
    {
      description: 'Import/export capabilities derived from the linked Squisq registry.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: 'docblocks://formats',
          mimeType: 'application/json',
          text: JSON.stringify({ formats: serializableCapabilities() }, null, 2),
        },
      ],
    }),
  );
}

function serializableCapabilities() {
  return MCP_FORMAT_CAPABILITIES.slice(0, 64).map((format) => ({
    id: requireWireFormat(format.id),
    label: boundWireText(format.label, MCP_WIRE_LIMITS.labelCharacters, format.id),
    mimeType: format.mimeType,
    extensions: boundWireTextArray(format.extensions, 64, MCP_WIRE_LIMITS.labelCharacters),
    import: { ...format.import },
    export: { ...format.export },
  }));
}

function requireWireFormat(value: string): string {
  requireWireIdentifier(value, 'format id');
  if (value.length > MCP_WIRE_LIMITS.formatCharacters || !MCP_OUTPUT_PATTERNS.format.test(value)) {
    throw new Error('Linked Squisq returned an invalid MCP format id');
  }
  return value;
}
