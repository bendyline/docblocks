import { useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { getHostEnvironment } from '@bendyline/docblocks/host';

import { Dialog } from '../components/Dialog.js';
import { openExternalUrl } from '../external-url.js';
import {
  AI_OUTPUT_REPORT_REASONS,
  AI_REPORT_DETAILS_CHARACTERS,
  AI_REPORT_OUTPUT_CHARACTERS,
  buildAiOutputReportUrl,
  type AiOutputReportReason,
} from '../DocBlocksShell/issue-report.js';

export interface AiReportButtonProps {
  /** The AI action that produced the response, such as "Rewrite selection". */
  feature: string;
  /** Reads the AI's response when the reporter opens the dialog. */
  getOutput: () => string;
  /** The model that produced the response, when the surface knows it. */
  model: string | null;
}

/**
 * Lets people flag an offensive, harmful or wrong AI response without leaving
 * the editor. App stores require this of apps that generate content with AI.
 */
export function AiReportButton({ feature, getOutput, model }: AiReportButtonProps) {
  const [output, setOutput] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="db-ai-link-button db-ai-report-button"
        onClick={() => setOutput(getOutput())}
      >
        Report output
      </button>
      {output !== null && (
        <AiReportDialog
          feature={feature}
          output={output}
          model={model}
          onClose={() => setOutput(null)}
        />
      )}
    </>
  );
}

interface AiReportDialogProps {
  feature: string;
  output: string;
  model: string | null;
  onClose: () => void;
}

function AiReportDialog({ feature, output, model, onClose }: AiReportDialogProps) {
  const [reason, setReason] = useState<AiOutputReportReason>('harmful');
  const [details, setDetails] = useState('');
  const [includeOutput, setIncludeOutput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstReasonRef = useRef<HTMLInputElement>(null);
  const name = useId();
  const hasOutput = output.trim().length > 0;

  const submit = () => {
    const environment = getHostEnvironment();
    const url = buildAiOutputReportUrl({
      feature,
      reason,
      model,
      details,
      output: includeOutput && hasOutput ? output : null,
      reportedAt: new Date(),
      version: environment ? `${environment.appVersion} ${environment.surfaceLabel}` : 'web',
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    });
    openExternalUrl(url).then(onClose, (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'Could not open the report.'),
    );
  };

  const dialog = (
    <Dialog
      title="Report AI output"
      onClose={onClose}
      initialFocusRef={firstReasonRef as RefObject<HTMLElement | null>}
      className="db-ai-report-dialog"
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={submit}>
            Open report
          </button>
        </>
      }
    >
      <p className="db-ai-report-intro">
        Tell us about an AI response that was offensive, harmful, or wrong. DocBlocks opens a GitHub
        issue with your report filled in, which you can edit before posting. GitHub issues are
        public.
      </p>
      <fieldset className="db-settings-fieldset">
        <legend className="db-settings-legend">What was wrong?</legend>
        {(Object.keys(AI_OUTPUT_REPORT_REASONS) as AiOutputReportReason[]).map((value, index) => (
          <label key={value} className="db-settings-radio">
            <input
              ref={index === 0 ? firstReasonRef : undefined}
              type="radio"
              name={name}
              value={value}
              checked={reason === value}
              onChange={() => setReason(value)}
            />
            {AI_OUTPUT_REPORT_REASONS[value]}
          </label>
        ))}
      </fieldset>
      <label className="db-ai-field">
        <span>Details (optional)</span>
        <textarea
          value={details}
          maxLength={AI_REPORT_DETAILS_CHARACTERS}
          rows={3}
          onChange={(event) => setDetails(event.currentTarget.value)}
        />
      </label>
      {hasOutput && (
        <>
          <label className="db-settings-checkbox">
            <input
              type="checkbox"
              checked={includeOutput}
              onChange={(event) => setIncludeOutput(event.currentTarget.checked)}
            />
            Include the AI response in the report
          </label>
          <p className="db-settings-hint">
            The response may contain text from your document. Up to{' '}
            {AI_REPORT_OUTPUT_CHARACTERS.toLocaleString()} characters are included.
          </p>
        </>
      )}
      {error && (
        <p className="db-ai-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
