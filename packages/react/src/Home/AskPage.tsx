import { useMemo, useSyncExternalStore } from 'react';
import { AiAskPanel, type AiAskPanelProps } from '../Ai/AiAskPanel.js';
import { AskChatList } from '../Ai/AskChatList.js';
import { resetAskProposals } from '../Ai/ask-proposals.js';
import { createWorkspaceAskSession } from '../Ai/workspace-ask.js';

/**
 * Ask as a page of its own: the workspace's saved chats beside the same
 * conversation as the editor's side panel (the shell holds it), with room to
 * read, and the task list's facts behind every question. There is no
 * document here to insert an answer into; answers can still be saved as notes.
 * On a phone, or a page too narrow for both, the chats are behind a button.
 */
export function AskPage({
  singlePane,
  onShowFiles,
  ...panel
}: Omit<AiAskPanelProps, 'inEditor' | 'chatList'> & {
  singlePane: boolean;
  onShowFiles: () => void;
}) {
  const { chats, sessionHolder } = panel;
  // The list's "New chat" and the panel share the shell's session.
  const session = useMemo(
    () => (sessionHolder.current ??= createWorkspaceAskSession()),
    [sessionHolder],
  );
  const { chat } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const beside = chats !== undefined && !singlePane;
  return (
    <section className="db-folder-view db-page db-ask-page" aria-label="Ask">
      {singlePane && (
        <button type="button" className="db-mobile-back" onClick={onShowFiles}>
          Back to files
        </button>
      )}
      <div className={`db-ask-page-body${beside ? ' db-ask-page-body--chats' : ''}`}>
        {beside && (
          <AskChatList
            chats={chats}
            activePath={chat?.workspaceId === chats.workspaceId ? chat.path : null}
            onNew={() => {
              session.clear();
              resetAskProposals(session);
            }}
          />
        )}
        <AiAskPanel {...panel} inEditor={false} chatList={beside ? 'beside' : 'toggle'} />
      </div>
    </section>
  );
}
