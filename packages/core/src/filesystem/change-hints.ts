/**
 * Change hints: "this storage may have changed underneath you; look again".
 *
 * Several backends cannot meet the `watch` contract (ordered, typed events
 * from a ready barrier), yet do learn that something changed: another tab
 * wrote to the same IndexedDB workspace, a phone's native layer saw iCloud
 * deliver a file, a browser reported a change in a picked folder. A hint
 * carries no path and no ordering. Consumers treat it like coming back to the
 * app: re-check what they show. That is cheap, and it can never be wrong.
 */

export interface FileSystemChangeHint {
  /** The provider whose storage changed, or null when the source cannot say. */
  readonly providerId: string | null;
}

export type FileSystemChangeHintListener = (hint: FileSystemChangeHint) => void;

const listeners = new Set<FileSystemChangeHintListener>();

/** Returns an idempotent unsubscribe. */
export function subscribeFileSystemChangeHints(listener: FileSystemChangeHintListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishFileSystemChangeHint(providerId: string | null = null): void {
  const hint: FileSystemChangeHint = { providerId };
  for (const listener of [...listeners]) {
    try {
      listener(hint);
    } catch {
      // A consumer that fails to re-check must not stop the others.
    }
  }
}

/** Tells other tabs and windows of this origin that storage changed, and hears them say so. */
export interface FileSystemChangeChannel {
  announce(): void;
  close(): void;
}

interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  /** Node: do not keep the process alive for this channel. */
  unref?(): void;
}

/**
 * Open the cross-tab channel for one stored workspace. A message from another
 * tab becomes a local hint for `providerId`. Null where the platform has no
 * BroadcastChannel; storage then simply goes unannounced, as before.
 */
export function openFileSystemChangeChannel(
  name: string,
  providerId: string,
): FileSystemChangeChannel | null {
  const Channel = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike })
    .BroadcastChannel;
  if (typeof Channel !== 'function') return null;
  let channel: BroadcastChannelLike | null;
  try {
    channel = new Channel(name);
  } catch {
    return null;
  }
  channel.unref?.();
  // The sender's own channel never receives its message, so this is other tabs only.
  channel.onmessage = () => publishFileSystemChangeHint(providerId);
  return {
    announce() {
      try {
        channel?.postMessage(1);
      } catch {
        // A closed or detached channel only means nobody is told.
      }
    },
    close() {
      const closing = channel;
      channel = null;
      if (!closing) return;
      closing.onmessage = null;
      try {
        closing.close();
      } catch {
        // Already closed.
      }
    },
  };
}
