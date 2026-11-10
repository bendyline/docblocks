/**
 * DeviceStorageNotice — the standing warning on a workspace the platform
 * deletes along with the app (Android's private "On this device" storage).
 *
 * Unlike the quiet Git notice beside it, this one is a real risk: uninstall
 * the app and the documents go with it. So it stays for as long as the
 * workspace is open, cannot be dismissed, and offers the one fix — moving the
 * documents into a folder that outlives the app.
 */

export interface DeviceStorageNoticeProps {
  /** Pick a folder and move this workspace's documents into it. */
  readonly onMove: () => void;
  /** A move is under way. */
  readonly moving: boolean;
}

export function DeviceStorageNotice({ onMove, moving }: DeviceStorageNoticeProps) {
  return (
    <div className="db-device-storage-notice" role="note">
      <p className="db-device-storage-notice-text">
        These documents are stored only inside DocBlocks and are deleted if you uninstall it.
      </p>
      <button
        type="button"
        className="db-device-storage-notice-action"
        onClick={onMove}
        disabled={moving}
      >
        {moving ? 'Moving…' : 'Move to a folder…'}
      </button>
    </div>
  );
}
