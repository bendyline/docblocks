/** Flags the AI-written study cards in a document (the control app stores require). */
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import { useAiStatus } from '../Ai/ai-status.js';
import { AiReportButton } from '../Ai/AiOutputReport.js';

export function StudyReport({ ai, output }: { ai: DocBlocksHostAiAPI; output: string }) {
  const status = useAiStatus(ai);
  return (
    <AiReportButton
      feature="Study cards"
      getOutput={() => output}
      model={status?.kind === 'ready' ? (status.model?.label ?? null) : null}
    />
  );
}
