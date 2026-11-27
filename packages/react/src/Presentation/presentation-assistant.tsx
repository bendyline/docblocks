/**
 * DocBlocks' AI, lent to Squisq's Custom summary designer.
 *
 * Squisq owns the designer (Write › Summarize, Custom) and everything about
 * wording a deck except the transport: the prompts, the reply checks, and the
 * saved design. DocBlocks makes the calls (`presentation-ai.ts`) and supplies
 * the "Report output" control app stores require beside AI-written text.
 *
 * The model calls and the report dialog load the first time they are used, so
 * lending the assistant costs the shell nothing at startup.
 */
import { lazy, Suspense } from 'react';
import type { SummarizationAssistant } from '@bendyline/squisq-editor-react';
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import { unavailableSentence } from '../Ai/ai-status.js';

const PresentationReport = lazy(() =>
  import('./presentation-report.js').then((module) => ({ default: module.PresentationReport })),
);

export function createPresentationAssistant(ai: DocBlocksHostAiAPI): SummarizationAssistant {
  return {
    readiness: async () => {
      const status = await ai.status();
      if (status.kind === 'ready' && status.model) return null;
      return unavailableSentence(status) || 'AI is not available.';
    },
    onReadinessChange: (listener) => ai.onStatus(() => listener()),
    suggestSlides: async (plan, { signal, onProgress, onBeat }) => {
      const { refinePresentationPlan } = await import('./presentation-ai.js');
      await refinePresentationPlan(ai, plan, { signal, onProgress, onBeat });
    },
    renderReport: (output) => (
      <Suspense fallback={null}>
        <PresentationReport ai={ai} output={output} />
      </Suspense>
    ),
  };
}
