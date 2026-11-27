import type { DocumentAutoSavePacing } from '@bendyline/docblocks/document';

/** Saving twice a second suits storage that only this app writes to. */
export const LOCAL_AUTOSAVE_PACING: DocumentAutoSavePacing = Object.freeze({ delayMs: 500 });

/**
 * A sync service keeps a version for every save and uploads each one. A
 * longer pause means fewer versions for two devices to collide over, and the
 * limit means steady typing is still on disk within a few seconds. Unsaved
 * text is journaled as it is typed either way, so nothing waits on this to be
 * safe from a crash.
 */
export const SYNCED_AUTOSAVE_PACING: DocumentAutoSavePacing = Object.freeze({
  delayMs: 1_500,
  maxWaitMs: 8_000,
});

/** Folder names the common sync clients use, as they appear in a workspace's location. */
const SYNCED_LOCATION =
  /(?:^|[\\/ ])(?:iCloud Drive|Mobile Documents|com~apple~CloudDocs|CloudStorage|OneDrive(?: - [^\\/]+)?|Dropbox|Google Drive|GoogleDrive|My Drive|Box|pCloud ?Drive|Nextcloud|Syncthing)(?:[\\/ ]|$)/iu;

/**
 * Whether a workspace's location looks like a folder a sync service looks
 * after. A guess from the location alone: a miss costs nothing but a save
 * that is more eager than it needs to be.
 */
export function isLikelySyncedLocation(location: string | null | undefined): boolean {
  return typeof location === 'string' && SYNCED_LOCATION.test(location);
}

/**
 * How eagerly to save in a workspace. Phones and tablets always take the
 * calmer pacing: their folders are iCloud Drive or another app's file
 * provider, and every save there is a coordinated write.
 */
export function autoSavePacingFor(workspace: {
  location: string | null | undefined;
  mobile: boolean;
}): DocumentAutoSavePacing {
  return workspace.mobile || isLikelySyncedLocation(workspace.location)
    ? SYNCED_AUTOSAVE_PACING
    : LOCAL_AUTOSAVE_PACING;
}
