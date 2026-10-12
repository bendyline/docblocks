import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import {
  MAX_NARRATION_CHARACTERS,
  narrationRewriteChunks,
  narrationRewriteRequest,
} from './narration-text.js';

/** Complete all parts before offering a replacement; cancellation/failure preserves the draft. */
export async function rewriteNarration(
  ai: Pick<DocBlocksHostAiAPI, 'chat'>,
  text: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<string> {
  if (text.length > MAX_NARRATION_CHARACTERS)
    throw new Error('The transcript is too long to rewrite.');
  const chunks = narrationRewriteChunks(text);
  let rewritten = '';
  for (const [index, chunk] of chunks.entries()) {
    signal.throwIfAborted();
    onProgress(index, chunks.length);
    const handle = ai.chat(narrationRewriteRequest(chunk), () => undefined);
    const cancel = () => handle.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await handle.done;
      signal.throwIfAborted();
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.finishReason !== 'stop') {
        throw new Error(
          'The AI rewrite was incomplete. Your transcript is unchanged. Try a shorter passage.',
        );
      }
      const output = result.value.text
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/giu, '')
        .trim();
      if (!output || /<(think|thinking|reasoning)>/iu.test(output)) {
        throw new Error('AI returned no usable text. Your transcript is unchanged.');
      }
      const separator = index === 0 ? '' : /\n\s*$/u.test(chunks[index - 1]) ? '\n\n' : ' ';
      rewritten += separator + output;
      if (rewritten.length > MAX_NARRATION_CHARACTERS)
        throw new Error('The AI rewrite is too long. Your transcript is unchanged.');
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  return rewritten;
}
