import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { formatFriendlyLastModified } from '../FileExplorer/last-modified.js';
import { DeleteIcon, NewChatIcon, RenameIcon } from '../icons.js';
import type { ChatListing } from './chat-folders.js';

/** Ask's saved chats in the open workspace, and what can be done with them. */
export interface AskChats {
  readonly items: readonly ChatListing[];
  /** The open workspace, whose chats these are. */
  readonly workspaceId: string;
  readonly onOpen: (path: string) => void;
  /** Give a chat a new name (its file name); resolves false when it was not renamed. */
  readonly onRename: (path: string, title: string) => Promise<boolean>;
  /** Delete a chat, after asking. */
  readonly onDelete: (path: string) => void;
}

function RenameField({
  title,
  onDone,
  onRename,
}: {
  title: string;
  onDone: () => void;
  onRename: (title: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Escape was pressed: a blur as the field goes away must not rename. */
  const cancelled = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = async (event?: FormEvent) => {
    event?.preventDefault();
    const next = value.trim();
    if (busy || cancelled.current) return;
    if (!next || next === title) {
      onDone();
      return;
    }
    setBusy(true);
    const renamed = await onRename(next).catch(() => false);
    setBusy(false);
    if (renamed) onDone();
    else inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelled.current = true;
      onDone();
    }
  };
  return (
    <form className="db-ai-ask-chat-rename" onSubmit={(event) => void commit(event)}>
      <input
        ref={inputRef}
        value={value}
        aria-label={`New name for ${title}`}
        maxLength={120}
        disabled={busy}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
    </form>
  );
}

/**
 * The list of saved chats: newest first, the one showing marked. Each opens,
 * renames (its file) or deletes in place; "New chat" starts afresh.
 */
export function AskChatList({
  chats,
  activePath,
  onNew,
  onPicked,
}: {
  chats: AskChats;
  /** The chat showing, when it is saved in this workspace; null otherwise. */
  activePath: string | null;
  onNew: () => void;
  /** After a chat is opened or a new one started, as a toggled list closes. */
  onPicked?: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const now = Date.now();
  return (
    <nav className="db-ai-ask-chats" aria-label="Chats">
      <div className="db-ai-ask-chats-header">
        <h3>Chats</h3>
        <button
          type="button"
          className="db-ai-ask-chats-new"
          onClick={() => {
            onNew();
            onPicked?.();
          }}
        >
          <NewChatIcon />
          New chat
        </button>
      </div>
      {chats.items.length === 0 ? (
        <p className="db-ai-ask-chats-empty">
          Chats are saved as notes in this workspace's Chats folder once they have an answer.
        </p>
      ) : (
        <ul>
          {chats.items.map((item) => {
            const active = item.path === activePath;
            const when = formatFriendlyLastModified(item.lastModified, now);
            return (
              <li
                key={item.path}
                className={`db-ai-ask-chat${active ? ' db-ai-ask-chat--active' : ''}`}
              >
                {renaming === item.path ? (
                  <RenameField
                    title={item.title}
                    onDone={() => setRenaming(null)}
                    onRename={(title) => chats.onRename(item.path, title)}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="db-ai-ask-chat-open"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => {
                        chats.onOpen(item.path);
                        onPicked?.();
                      }}
                    >
                      <span className="db-ai-ask-chat-title">{item.title}</span>
                      {when && (
                        <span className="db-ai-ask-chat-when" title={when.title}>
                          {when.shortLabel}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="db-ai-ask-chat-tool"
                      aria-label={`Rename ${item.title}`}
                      title="Rename"
                      onClick={() => setRenaming(item.path)}
                    >
                      <RenameIcon />
                    </button>
                    <button
                      type="button"
                      className="db-ai-ask-chat-tool"
                      aria-label={`Delete ${item.title}`}
                      title="Delete"
                      onClick={() => chats.onDelete(item.path)}
                    >
                      <DeleteIcon />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
