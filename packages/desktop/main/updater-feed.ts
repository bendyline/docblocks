/**
 * Windows update feeds.
 *
 * Every desktop release publishes three NSIS installers, each named by the
 * manifest electron-updater reads to find it:
 *
 *   latest-win-x64.yml    DocBlocks-<version>-win-x64.exe
 *   latest-win-arm64.yml  DocBlocks-<version>-win-arm64.exe
 *   latest.yml            DocBlocks-<version>-win.exe, which holds both builds
 *
 * The app follows the manifest for the machine's architecture, so an update
 * downloads only the build it installs. latest.yml stays for 2.7.14 and
 * earlier, which read nothing else, and as the fallback when a release has no
 * manifest for the architecture. scripts/prepare-windows-updater-manifest.ts
 * writes all three under these names.
 */

export const WINDOWS_FEED_ARCHITECTURES = ['x64', 'arm64'] as const;

export type WindowsFeedArchitecture = (typeof WINDOWS_FEED_ARCHITECTURES)[number];

/** electron-updater's default channel, whose Windows manifest is latest.yml. */
export const COMBINED_WINDOWS_FEED_CHANNEL = 'latest';

/** electron-updater reads `<channel>.yml` from the newest release. */
export function windowsFeedChannel(architecture: WindowsFeedArchitecture): string {
  return `latest-win-${architecture}`;
}

function isWindowsFeedArchitecture(value: string): value is WindowsFeedArchitecture {
  return (WINDOWS_FEED_ARCHITECTURES as readonly string[]).includes(value);
}

/**
 * The channel this machine follows, or null to stay on the combined feed.
 *
 * `runningUnderArm64Translation` is Electron's `app.runningUnderARM64Translation`.
 * An x64 build emulated on an ARM64 machine follows the arm64 feed: the
 * combined installer has always installed the native build there, and the
 * arm64 feed keeps moving such an install to it.
 */
export function windowsUpdateChannel(
  processArchitecture: string,
  runningUnderArm64Translation: boolean,
): string | null {
  const architecture = runningUnderArm64Translation ? 'arm64' : processArchitecture;
  return isWindowsFeedArchitecture(architecture) ? windowsFeedChannel(architecture) : null;
}

/** True when the newest release has no manifest for the channel that was asked for. */
export function isMissingFeedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
  );
}
