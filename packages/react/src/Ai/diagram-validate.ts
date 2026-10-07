/**
 * Confirm compiled markup renders before it is offered.
 *
 * The compiler should only ever produce valid markup, so a failure here is a
 * compiler bug, not a model mistake — it is reported, never repaired by
 * asking the model again.
 */

import {
  detectAsciiTimeline,
  parseAsciiTimeline,
  validateMarkdownSource,
} from '@bendyline/squisq/doc';
import type { CompiledDiagram } from './diagram-compile.js';

/** Checks Mermaid source; the editor's `validateMermaidSource` in production. */
export type MermaidValidator = (
  source: string,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;

export type DiagramValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Diagnostics that mean a drawing or layout would not render as compiled. */
const BLOCKING_CODES = new Set([
  'unknown-shape',
  'unknown-layer',
  'unknown-template',
  'shape-outside-drawing',
  'unresolved-connection',
  'invalid-attribute',
  'unparsed-annotation',
  'duplicate-id',
  'layout-image-missing-src',
]);

function fenceBody(markdown: string): string {
  const firstLine = markdown.indexOf('\n');
  const close = markdown.lastIndexOf('\n```');
  return firstLine >= 0 && close > firstLine ? markdown.slice(firstLine + 1, close) : '';
}

export async function validateCompiledDiagram(
  compiled: CompiledDiagram,
  validateMermaid: MermaidValidator,
): Promise<DiagramValidation> {
  if (compiled.family === 'mermaid') {
    if (!compiled.mermaidSource) return { ok: false, message: 'No Mermaid source was produced.' };
    const result = await validateMermaid(compiled.mermaidSource);
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }
  const markdown = compiled.render(2, new Set());
  if (compiled.family === 'timeline') {
    const body = fenceBody(markdown);
    if (!detectAsciiTimeline(body, { explicit: true }).isTimeline) {
      return { ok: false, message: 'The timeline was not recognized.' };
    }
    const warnings = parseAsciiTimeline(body).warnings;
    return warnings.length === 0 ? { ok: true } : { ok: false, message: warnings.join(' ') };
  }
  const blocking = validateMarkdownSource(markdown).diagnostics.filter(
    (diagnostic) => diagnostic.severity !== 'info' && BLOCKING_CODES.has(diagnostic.code),
  );
  return blocking.length === 0
    ? { ok: true }
    : { ok: false, message: blocking.map((diagnostic) => diagnostic.message).join(' ') };
}
