import type { Block } from '@bendyline/squisq/schemas';
import type { AnalyzedBlock } from '@bendyline/squisq/transform';

/**
 * Analyze every structural block in canonical pre-order.
 *
 * Squisq's transform analyzer intentionally selects leaves (plus empty
 * containers) for transform promotion. Inspection has a different contract:
 * a parent with authored body content remains observable even when it owns
 * child sections. Analyze each flattened block as an isolated leaf, then
 * restore the original block identity and canonical image index.
 */
export async function analyzeDocumentBlocks(blocks: Block[]): Promise<AnalyzedBlock[]> {
  const [{ flattenBlocks }, { analyzeBlocks }] = await Promise.all([
    import('@bendyline/squisq/doc'),
    import('@bendyline/squisq/transform'),
  ]);
  const flattened = flattenBlocks(blocks);
  return flattened.map((block, sourceBlockIndex) => {
    const { children: _children, ...isolatedBlock } = block;
    void _children;
    const analyzed = analyzeBlocks([isolatedBlock])[0];
    if (!analyzed) throw new Error(`Unable to analyze document block "${block.id}"`);
    return {
      ...analyzed,
      block,
      hasChildren: (block.children?.length ?? 0) > 0,
      images: analyzed.images.map((image) => ({ ...image, sourceBlockIndex })),
    };
  });
}
