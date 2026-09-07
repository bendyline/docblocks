import { markdownToDoc } from '@bendyline/squisq/doc';
import type { MarkdownDocument } from '@bendyline/squisq/markdown';

/** Honor the MCP's explicit heading boundary before the template renderer flattens blocks. */
export function preparePptxSource(
  markdown: MarkdownDocument,
  slideBreak: 'h1' | 'h2' | 'heading',
  autoTemplates?: boolean,
) {
  const maxDepth = slideBreak === 'h1' ? 1 : slideBreak === 'h2' ? 2 : 6;
  const grouped: MarkdownDocument = {
    ...markdown,
    children: markdown.children.map((node) =>
      node.type === 'heading' && node.depth > maxDepth
        ? {
            type: 'paragraph' as const,
            children: [{ type: 'strong' as const, children: node.children }],
          }
        : node,
    ),
  };
  // An authored title heading already owns slide 1. Adding a generated cover
  // violates an explicit one-slide-per-heading contract.
  return {
    markdownDoc: grouped,
    doc: markdownToDoc(grouped, { generateCoverBlock: false, autoTemplates }),
  };
}
