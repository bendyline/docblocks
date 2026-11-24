import { AiAskPanel, type AiAskPanelProps } from '../Ai/AiAskPanel.js';

/**
 * Ask your workspace as a page of its own: the same conversation as the
 * editor's side panel (the shell holds it), with room to read, and the task
 * list's facts behind every question. There is no document here to insert an
 * answer into; answers can still be saved as notes.
 */
export function AskPage({
  singlePane,
  onShowFiles,
  ...panel
}: Omit<AiAskPanelProps, 'inEditor'> & {
  singlePane: boolean;
  onShowFiles: () => void;
}) {
  return (
    <section className="db-folder-view db-page db-ask-page" aria-label="Ask">
      {singlePane && (
        <button type="button" className="db-mobile-back" onClick={onShowFiles}>
          Back to files
        </button>
      )}
      <AiAskPanel {...panel} inEditor={false} />
    </section>
  );
}
