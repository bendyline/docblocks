import { expect } from 'chai';
import type { PreviewResult } from '@bendyline/docblocks/mcp';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { inlinePreviewContent, MAX_INLINE_PREVIEW_BYTES } from '../src/mcp/preview-content.js';

describe('bounded model-visible preview images', () => {
  it('keeps the encoded image budget and names the exact omitted item for pagination', async () => {
    const store = new ArtifactStore();
    try {
      const small = await store.put({
        bytes: Buffer.from('preview'),
        format: 'png',
        mimeType: 'image/png',
        suggestedFilename: 'small.png',
      });
      const big = await store.put({
        bytes: Buffer.alloc(MAX_INLINE_PREVIEW_BYTES),
        format: 'png',
        mimeType: 'image/png',
        suggestedFilename: 'large.png',
      });
      const result: PreviewResult = {
        version: 1,
        kind: 'preview',
        sourceFormat: 'pptx',
        previewBasis: 'reconstructed-import',
        totalItems: 3,
        truncated: false,
        diagnostics: [],
        items: [small, big, small].map((artifact, index) => ({
          artifact,
          index,
          label: null,
          kind: 'slide',
          width: 640,
          height: 360,
        })),
      };
      const reads: string[] = [];
      const content = await inlinePreviewContent(result, {
        read: async (uri, signal) => {
          reads.push(uri);
          return store.read(uri, signal);
        },
      });
      const images = content.filter((item) => item.type === 'image');
      expect(images).to.have.length(2);
      expect(images.reduce((size, image) => size + image.data.length, 0)).to.be.at.most(
        MAX_INLINE_PREVIEW_BYTES,
      );
      expect(reads).not.to.include(big.uri);
      expect(
        content.some((item) => item.type === 'text' && item.text.includes('startIndex: 1')),
      ).to.equal(true);
      const controller = new AbortController();
      controller.abort();
      let cancelled = false;
      try {
        await inlinePreviewContent(result, store, controller.signal);
      } catch {
        cancelled = true;
      }
      expect(cancelled).to.equal(true);
    } finally {
      await store.dispose();
    }
  });
});
