import { markdownToDoc } from '@bendyline/squisq/doc';
import type {
  MarkdownBlockNode,
  MarkdownDocument,
  MarkdownFootnoteDefinition,
  MarkdownInlineNode,
} from '@bendyline/squisq/markdown';

/** Honor the MCP's explicit heading boundary before the template renderer flattens blocks. */
export function preparePptxSource(
  markdown: MarkdownDocument,
  slideBreak: 'h1' | 'h2' | 'heading',
  autoTemplates?: boolean,
) {
  const maxDepth = slideBreak === 'h1' ? 1 : slideBreak === 'h2' ? 2 : 6;
  const grouped: MarkdownDocument = citationsToFootnotes({
    ...markdown,
    children: markdown.children.map((node) =>
      node.type === 'heading' && node.depth > maxDepth
        ? {
            type: 'paragraph' as const,
            children: [{ type: 'strong' as const, children: node.children }],
          }
        : node,
    ),
  });
  // An authored title heading already owns slide 1. Adding a generated cover
  // violates an explicit one-slide-per-heading contract.
  return {
    markdownDoc: grouped,
    doc: markdownToDoc(grouped, { generateCoverBlock: false, autoTemplates }),
  };
}

/**
 * `(source: …)` / `(sources: …)` after a claim, as AI-written documents cite.
 * The citation may not hold parentheses, so it ends at the first `)`.
 */
const SOURCE_CITATION = /\s*\((sources?):\s*([^()]+?)\s*\)/gi;

/** Nodes whose children are inline text. */
const INLINE_PARENTS = new Set(['paragraph', 'heading', 'tableCell']);
/** Inline nodes whose text is not prose to rewrite. */
const OPAQUE_INLINE = new Set(['inlineCode', 'link', 'image', 'html', 'inlineMath']);

/**
 * Move inline `(source: …)` citations into footnotes, which the deck exporter
 * writes as each slide's speaker notes. A document that cites its sources
 * after every claim reads as a log on a slide; a presenter wants the sources
 * in the notes, and the Markdown keeps them inline for whoever checks it.
 * Each distinct citation becomes one footnote, reused wherever it repeats.
 */
export function citationsToFootnotes(markdown: MarkdownDocument): MarkdownDocument {
  const taken = new Set<string>();
  for (const node of markdown.children) {
    if (node.type === 'footnoteDefinition') taken.add(node.identifier);
  }
  const ids = new Map<string, { identifier: string; text: string }>();
  const idFor = (keyword: string, citation: string): string => {
    const text = `${keyword.toLowerCase() === 'sources' ? 'Sources' : 'Source'}: ${citation}`;
    const known = ids.get(text);
    if (known) return known.identifier;
    let n = ids.size + 1;
    while (taken.has(`source-${n}`)) n += 1;
    const identifier = `source-${n}`;
    taken.add(identifier);
    ids.set(text, { identifier, text });
    return identifier;
  };

  const splitText = (value: string): MarkdownInlineNode[] => {
    const out: MarkdownInlineNode[] = [];
    let last = 0;
    for (const match of value.matchAll(SOURCE_CITATION)) {
      const before = value.slice(last, match.index);
      if (before) out.push({ type: 'text', value: before });
      const identifier = idFor(match[1]!, match[2]!);
      out.push({ type: 'footnoteReference', identifier, label: identifier });
      last = match.index! + match[0].length;
    }
    if (last === 0) return [{ type: 'text', value }];
    const after = value.slice(last);
    if (after) out.push({ type: 'text', value: after });
    return out;
  };

  const rewriteInline = (nodes: readonly MarkdownInlineNode[]): MarkdownInlineNode[] =>
    nodes.flatMap((node) => {
      if (node.type === 'text') return splitText(node.value);
      if (OPAQUE_INLINE.has(node.type)) return [node];
      const children = (node as { children?: MarkdownInlineNode[] }).children;
      return Array.isArray(children)
        ? [{ ...node, children: rewriteInline(children) } as MarkdownInlineNode]
        : [node];
    });

  const rewriteBlock = (node: MarkdownBlockNode): MarkdownBlockNode => {
    const children = (node as { children?: unknown[] }).children;
    if (!Array.isArray(children) || node.type === 'footnoteDefinition') return node;
    return INLINE_PARENTS.has(node.type)
      ? ({
          ...node,
          children: rewriteInline(children as MarkdownInlineNode[]),
        } as MarkdownBlockNode)
      : ({
          ...node,
          children: (children as MarkdownBlockNode[]).map(rewriteBlock),
        } as MarkdownBlockNode);
  };

  const children = markdown.children.map(rewriteBlock);
  if (ids.size === 0) return markdown;
  const definitions: MarkdownFootnoteDefinition[] = [...ids.values()].map(
    ({ identifier, text }) => ({
      type: 'footnoteDefinition',
      identifier,
      label: identifier,
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }),
  );
  return { ...markdown, children: [...children, ...definitions] };
}
