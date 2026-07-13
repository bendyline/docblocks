import {
  DOCBLOCKS_MCP_WIRE_VERSION,
  MCP_WIRE_LIMITS,
  parseMcpErrorResult,
  type DiagnosticStage,
  type McpErrorResult,
} from '@bendyline/docblocks/mcp';
import { boundWireText } from './output-bounds.js';

/** Produce one exact error envelope for every MCP tool generation. */
export function errorResult(
  caught: unknown,
  stage: DiagnosticStage | null = null,
  formatOverride: string | null = null,
  requestSignal?: AbortSignal,
) {
  const error = normalizeError(caught, stage, formatOverride, requestSignal?.aborted === true);
  const payload = parseMcpErrorResult({
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'error',
    result: null,
    error,
  });
  if (!payload) throw new Error('DocBlocks generated an invalid MCP error envelope');
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: true as const,
  };
}

export function successResult<T extends object>(result: T) {
  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'success' as const,
    result,
    error: null,
  };
}

function normalizeError(
  caught: unknown,
  stage: DiagnosticStage | null,
  formatOverride: string | null,
  cancelled: boolean,
): McpErrorResult['error'] {
  const candidate =
    caught && typeof caught === 'object' ? (caught as Record<string, unknown>) : undefined;
  const message = boundedErrorText(caught instanceof Error ? caught.message : String(caught));
  const normalizedMessage = message.toLowerCase();
  const stableCode =
    typeof candidate?.code === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(candidate.code)
      ? candidate.code
      : undefined;
  const code =
    (cancelled ? 'cancelled' : stableCode) ??
    (normalizedMessage.includes('busy')
      ? 'busy'
      : normalizedMessage.includes('timeout') || normalizedMessage.includes('runtime budget')
        ? 'timeout'
        : normalizedMessage.includes('cancel') || normalizedMessage.includes('abort')
          ? 'cancelled'
          : normalizedMessage.includes('outside') || normalizedMessage.includes('root')
            ? 'unauthorized-path'
            : normalizedMessage.includes('already exists') ||
                normalizedMessage.includes('precondition')
              ? 'conflict'
              : normalizedMessage.includes('format')
                ? 'unknown-format'
                : 'operation-failed');
  const candidateFormat = typeof candidate?.format === 'string' ? candidate.format : formatOverride;
  const active = candidate?.active;
  const capacity = candidate?.capacity;
  const operationLoad =
    Number.isSafeInteger(active) &&
    typeof active === 'number' &&
    active >= 0 &&
    active <= 32 &&
    Number.isSafeInteger(capacity) &&
    typeof capacity === 'number' &&
    capacity >= 1 &&
    capacity <= 32 &&
    active <= capacity
      ? { active, capacity }
      : null;
  return {
    code,
    message,
    stage,
    format:
      candidateFormat && /^[a-z0-9][a-z0-9.+_-]{0,63}$/u.test(candidateFormat)
        ? candidateFormat
        : null,
    hint: typeof candidate?.hint === 'string' ? boundedErrorText(candidate.hint) : null,
    retryable:
      typeof candidate?.retryable === 'boolean'
        ? candidate.retryable
        : code === 'busy' || code === 'cancelled' || code === 'timeout',
    operationLoad,
  };
}

function boundedErrorText(value: string): string {
  return boundWireText(value, MCP_WIRE_LIMITS.messageCharacters, 'MCP operation failed');
}
