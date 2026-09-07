import type { PreviewResult } from '@bendyline/docblocks/mcp';
import type { ArtifactStore } from './artifact-store.js';

/** Bound encoded image payloads independently of the larger artifact-store quota. */
export const MAX_INLINE_PREVIEW_BYTES = 4 * 1024 * 1024;

type PreviewContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export async function inlinePreviewContent(
  result: PreviewResult,
  artifacts: Pick<ArtifactStore, 'read'>,
  signal?: AbortSignal,
): Promise<PreviewContent[]> {
  const content: PreviewContent[] = [];
  let remaining = MAX_INLINE_PREVIEW_BYTES;
  for (const item of result.items) {
    signal?.throwIfAborted();
    const encodedSize = 4 * Math.ceil(item.artifact.size / 3);
    if (encodedSize > remaining) {
      content.push({
        type: 'text',
        text: `Preview item ${item.index} is available by resource link but was not inlined because of the response-size budget. Request startIndex: ${item.index}, maxItems: 1 and smaller width/height to inspect its pixels.`,
      });
      continue;
    }
    const bytes = await artifacts.read(item.artifact.uri, signal);
    const data = bytes.toString('base64');
    remaining -= data.length;
    content.push({
      type: 'text',
      text: `Preview item ${item.index}${item.label ? `: ${item.label}` : ''} (${result.previewBasis})`,
    });
    content.push({ type: 'image', mimeType: item.artifact.mimeType, data });
  }
  return content;
}
