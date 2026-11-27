/** Flags the AI slide wording held in a Custom summary design. */
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import { useAiStatus } from '../Ai/ai-status.js';
import { AiReportButton } from '../Ai/AiOutputReport.js';

export function PresentationReport({ ai, output }: { ai: DocBlocksHostAiAPI; output: string }) {
  const status = useAiStatus(ai);
  return (
    <AiReportButton
      feature="Suggest slides"
      getOutput={() => output}
      model={status?.kind === 'ready' ? (status.model?.label ?? null) : null}
    />
  );
}
