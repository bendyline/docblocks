/**
 * What Ask offers to do after an answer, and the confirmation for each.
 *
 * "Suggest tasks and notes" asks the model for actions as structured data
 * (see `chat-actions.ts`). Each one is shown as a card; nothing is written
 * until the person chooses Do it. Edits to existing documents are offered only
 * after "Allow edits to cited notes" is ticked for the conversation, only for
 * documents the answer cited, and each needs its own click.
 *
 * Proposals belong to the conversation, not to this component; see
 * `ask-proposals.ts`.
 */

import { useState, useSyncExternalStore } from 'react';
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';

import { chatOnce, TRY_AGAIN } from './chat-once.js';
import {
  actionsRequest,
  describeAction,
  isEdit,
  parseProposedActions,
  type AppliedAction,
} from './chat-actions.js';
import {
  citedTargets,
  proposalStoreFor,
  type AskActions,
  type ProposalEntry,
} from './ask-proposals.js';
import { stripCitationMarkers } from './knowledge-citations.js';
import type { AskTurn, WorkspaceAskSession } from './workspace-ask.js';

/** The conversation's proposals and its "allow edits" choice. */
function useAskProposals(session: WorkspaceAskSession) {
  const store = proposalStoreFor(session);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, snapshot };
}

export function AllowEditsToggle({ session }: { session: WorkspaceAskSession }) {
  const { store, snapshot } = useAskProposals(session);
  return (
    <label className="db-ai-ask-allow">
      <input
        type="checkbox"
        checked={snapshot.allowEdits}
        onChange={(event) => store.setAllowEdits(event.currentTarget.checked)}
      />
      Allow edits to cited notes
    </label>
  );
}

function Card({
  entry,
  editsAllowed,
  onRun,
  onSkip,
  onOpen,
}: {
  entry: ProposalEntry;
  /** Off: an edit card waits, and says how to allow it. */
  editsAllowed: boolean;
  onRun: () => void;
  onSkip: () => void;
  onOpen: (() => void) | null;
}) {
  const { action } = entry;
  const waiting = isEdit(action) && !editsAllowed;
  const preview =
    action.kind === 'create-note' || action.kind === 'append-to-document'
      ? action.markdown
      : action.kind === 'create-task'
        ? (action.notes ?? null)
        : null;
  return (
    <li
      className={`db-ai-proposal${isEdit(action) ? ' db-ai-proposal--edit' : ''}`}
      data-state={entry.state}
    >
      <p className="db-ai-proposal-what">{describeAction(action)}</p>
      {preview && (
        <details className="db-ai-proposal-preview">
          <summary>{action.kind === 'append-to-document' ? 'What will be added' : 'Text'}</summary>
          <pre>{preview}</pre>
        </details>
      )}
      <div className="db-ai-proposal-actions">
        {(entry.state === 'offered' || entry.state === 'failed') && waiting && (
          <span className="db-ai-note">Tick “Allow edits to cited notes” to make this change.</span>
        )}
        {entry.state === 'offered' && (
          <>
            {!waiting && (
              <button type="button" onClick={onRun}>
                {isEdit(action) ? 'Make this change' : 'Do it'}
              </button>
            )}
            <button type="button" onClick={onSkip}>
              Skip
            </button>
          </>
        )}
        {entry.state === 'running' && (
          <span className="db-ai-note" role="status">
            <span className="db-ai-spinner" aria-hidden="true" />
            Working…
          </span>
        )}
        {entry.state === 'done' && (
          <>
            <span className="db-ai-note" role="status">
              {!isEdit(action)
                ? 'Done.'
                : entry.versionKept
                  ? 'Changed. The earlier text is kept in Versions.'
                  : 'Changed.'}
            </span>
            {onOpen && (
              <button type="button" onClick={onOpen}>
                Open
              </button>
            )}
          </>
        )}
        {entry.state === 'skipped' && <span className="db-ai-note">Skipped.</span>}
        {entry.state === 'failed' && (
          <>
            <span className="db-ai-note">Not done.</span>
            {!waiting && (
              <button type="button" onClick={onRun}>
                Try again
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/** "Suggest tasks and notes" for one answer, and the cards it brings back. */
export function TurnProposalsBlock({
  turn,
  session,
  ai,
  facts,
  actions,
}: {
  turn: AskTurn;
  session: WorkspaceAskSession;
  ai: Pick<DocBlocksHostAiAPI, 'chat'>;
  facts: (() => string | null) | undefined;
  actions: AskActions;
}) {
  const { store, snapshot } = useAskProposals(session);
  const [doingAll, setDoingAll] = useState(false);
  const proposals = snapshot.turns.get(turn.id) ?? null;
  const allowEdits = snapshot.allowEdits;

  const suggest = async () => {
    const controller = new AbortController();
    store.set(turn.id, { status: 'thinking', controller });
    const targets = allowEdits ? citedTargets(turn) : [];
    const outcome = await chatOnce(
      ai,
      actionsRequest({
        question: turn.question,
        answer: stripCitationMarkers(turn.answer),
        facts: facts?.() ?? null,
        allowEdits,
        targets,
      }),
      controller.signal,
    );
    if (outcome.kind === 'cancelled') {
      store.set(turn.id, null);
      return;
    }
    if (outcome.kind === 'error') {
      store.set(turn.id, { status: 'error', message: outcome.error.message });
      return;
    }
    const proposed = parseProposedActions(outcome.text, { allowEdits, targets });
    if (proposed.length === 0) {
      // An empty list is a real answer; text that held no list at all is a failed reply.
      store.set(
        turn.id,
        /"actions"\s*:\s*\[\s*\]/.test(outcome.text)
          ? { status: 'none' }
          : { status: 'error', message: `No suggestions came back. ${TRY_AGAIN}` },
      );
      return;
    }
    store.set(turn.id, {
      status: 'ready',
      entries: proposed.map((action) => ({
        action,
        state: 'offered',
        path: null,
        versionKept: false,
      })),
    });
  };

  const run = async (index: number) => {
    // A card skipped, done or already started since it was shown does not run.
    const action = store.claim(turn.id, index);
    if (!action) return;
    let applied: AppliedAction | null = null;
    try {
      applied = await actions.run(action);
    } catch {
      applied = null;
    }
    store.updateEntry(turn.id, index, {
      state: applied ? 'done' : 'failed',
      path: applied?.path ?? null,
      versionKept: applied?.versionKept === true,
    });
  };

  if (!proposals) {
    return (
      <div className="db-ai-proposals">
        <button type="button" onClick={() => void suggest()}>
          {allowEdits ? 'Suggest tasks, notes and edits' : 'Suggest tasks and notes'}
        </button>
      </div>
    );
  }
  if (proposals.status === 'thinking') {
    return (
      <div className="db-ai-proposals">
        <span className="db-ai-ask-chip" role="status">
          <span className="db-ai-spinner" aria-hidden="true" />
          Looking for things to do…
        </span>
        <button type="button" onClick={() => proposals.controller.abort()}>
          Stop
        </button>
      </div>
    );
  }
  if (proposals.status === 'none' || proposals.status === 'error') {
    return (
      <div className="db-ai-proposals">
        <p className="db-ai-note" role="status">
          {proposals.status === 'none' ? 'Nothing to add from this answer.' : proposals.message}
        </p>
        <button type="button" onClick={() => void suggest()}>
          Ask again
        </button>
      </div>
    );
  }

  const creations = proposals.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.state === 'offered' && !isEdit(entry.action));
  const doAll = async () => {
    setDoingAll(true);
    // One at a time: tasks set up a folder the first time, and journal lines
    // append in order. Each card is claimed as it comes up, so one skipped or
    // done by hand meanwhile is passed over.
    for (const { index } of creations) await run(index);
    setDoingAll(false);
  };

  return (
    <div className="db-ai-proposals">
      <ul className="db-ai-proposal-list" aria-label="Suggestions">
        {proposals.entries.map((entry, index) => (
          <Card
            key={index}
            entry={entry}
            editsAllowed={allowEdits}
            onRun={() => void run(index)}
            onSkip={() => store.updateEntry(turn.id, index, { state: 'skipped' })}
            onOpen={entry.path ? () => actions.open(entry.path!) : null}
          />
        ))}
      </ul>
      {creations.length > 1 && (
        <button type="button" disabled={doingAll} onClick={() => void doAll()}>
          Do all {creations.length}
        </button>
      )}
    </div>
  );
}
