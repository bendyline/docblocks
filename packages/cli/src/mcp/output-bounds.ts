import { createHash } from 'node:crypto';
import { MCP_WIRE_LIMITS } from '@bendyline/docblocks/mcp';

export const MCP_OUTPUT_PATTERNS = Object.freeze({
  identifier: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
  format: /^[a-z0-9][a-z0-9.+_-]*$/u,
  sha256: /^[a-f0-9]{64}$/u,
});

export function isWireText(value: string): boolean {
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 0 || codePoint === 0x7f;
  });
}

export function boundWireText(
  value: string,
  maximumCharacters: number = MCP_WIRE_LIMITS.messageCharacters,
  fallback = '',
): string {
  const bounded = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0 || codePoint === 0x7f ? '\uFFFD' : character;
    })
    .join('')
    .slice(0, maximumCharacters);
  return bounded || fallback.slice(0, maximumCharacters);
}

export function boundNullableWireText(
  value: string | null | undefined,
  maximumCharacters: number,
): string | null {
  return value === null || value === undefined ? null : boundWireText(value, maximumCharacters);
}

export function boundWireTextArray(
  values: readonly string[],
  maximumEntries: number = MCP_WIRE_LIMITS.arrayEntries,
  maximumCharacters: number = MCP_WIRE_LIMITS.messageCharacters,
): string[] {
  return values.slice(0, maximumEntries).map((value) => boundWireText(value, maximumCharacters));
}

export function boundWireWarnings(values: readonly string[]): string[] {
  if (values.length <= MCP_WIRE_LIMITS.arrayEntries) return boundWireTextArray(values);
  const retained = boundWireTextArray(values, MCP_WIRE_LIMITS.arrayEntries - 1);
  retained.push(
    `${values.length - retained.length} additional warnings were aggregated to keep the MCP result bounded.`,
  );
  return retained;
}

export function requireWireIdentifier(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > MCP_WIRE_LIMITS.identifierCharacters ||
    !MCP_OUTPUT_PATTERNS.identifier.test(value) ||
    !isWireText(value)
  ) {
    throw new Error(`Linked Squisq returned an invalid MCP ${label}`);
  }
  return value;
}

export function toWireIdentifier(value: string, fallbackPrefix = 'item'): string {
  if (
    value.length >= 1 &&
    value.length <= MCP_WIRE_LIMITS.identifierCharacters &&
    MCP_OUTPUT_PATTERNS.identifier.test(value) &&
    isWireText(value)
  ) {
    return value;
  }
  const hash = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
  const safePrefix = value
    .replace(/[^A-Za-z0-9._:-]+/gu, '-')
    .replace(/^[^A-Za-z0-9]+/u, '')
    .slice(0, MCP_WIRE_LIMITS.identifierCharacters - hash.length - 1);
  const prefix = safePrefix || fallbackPrefix;
  return `${prefix}-${hash}`.slice(0, MCP_WIRE_LIMITS.identifierCharacters);
}
