/**
 * DocBlocks' AI, lent to Squisq's Study cards view.
 *
 * Squisq owns the view (Write › Study cards), the card format, and
 * everything about making cards except the transport. DocBlocks makes the
 * calls (`study-ai.ts`) and supplies the "Report output" control app stores
 * require beside AI-written text.
 *
 * The model calls and the report dialog load the first time they are used,
 * so lending the assistant costs the shell nothing at startup (nothing here
 * imports Squisq's study code).
 */
import { lazy, Suspense } from 'react';
import type { StudyAssistant } from '@bendyline/squisq-editor-react';
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import { unavailableSentence } from '../Ai/ai-status.js';

const StudyReport = lazy(() =>
  import('./study-report.js').then((module) => ({ default: module.StudyReport })),
);

export function createStudyAssistant(ai: DocBlocksHostAiAPI): StudyAssistant {
  const readiness = async () => {
    const status = await ai.status();
    if (status.kind === 'ready' && status.model) return null;
    return unavailableSentence(status) || 'AI is not available.';
  };
  return {
    readiness,
    onReadinessChange: (listener) => ai.onStatus(() => listener()),
    generateCards: async (request, { signal, onProgress, onCard, onSection }) => {
      const status = await ai.status();
      if (status.kind !== 'ready' || !status.model)
        throw new Error(unavailableSentence(status) || 'AI is not available.');
      const { generateStudyCards } = await import('./study-ai.js');
      await generateStudyCards(ai, request.sections, {
        model: status.model,
        kinds: request.kinds,
        ...(request.title ? { title: request.title } : {}),
        ...(request.counts
          ? {
              countFor: (section, kind) => request.counts?.[section.blockId]?.[kind] ?? 0,
            }
          : {}),
        signal,
        onProgress,
        onCard,
        ...(onSection ? { onSection } : {}),
      });
    },
    renderReport: (output) => (
      <Suspense fallback={null}>
        <StudyReport ai={ai} output={output} />
      </Suspense>
    ),
  };
}
