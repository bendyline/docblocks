/**
 * The Windows updater.
 *
 * electron-updater's NSIS updater, with the two things DocBlocks' Windows
 * releases need from it: it follows the feed for the machine's architecture
 * (updater-feed.ts), and it skips a differential download that cannot succeed
 * (updater-differential.ts).
 */

import path from 'node:path';
import pkg, { type Provider, type ResolvedUpdateFileInfo, type UpdateInfo } from 'electron-updater';
import type {
  DownloadUpdateOptions,
  UpdateInfoAndProvider,
} from 'electron-updater/out/AppUpdater.js';
import {
  CACHED_BLOCKMAP_FILE,
  MAX_COMPRESSED_BLOCKMAP_BYTES,
  differentialBaseProblem,
} from './updater-differential.js';
import { COMBINED_WINDOWS_FEED_CHANNEL, isMissingFeedError } from './updater-feed.js';

const { NsisUpdater } = pkg;

const BLOCKMAP_DOWNLOAD_TIMEOUT_MS = 60_000;

export class WindowsUpdater extends NsisUpdater {
  /**
   * @param architectureChannel The per-architecture feed this machine follows
   *   (`windowsUpdateChannel`), or null to stay on the combined one.
   */
  constructor(private readonly architectureChannel: string | null) {
    super();
    if (architectureChannel !== null) this.follow(architectureChannel);
  }

  private follow(channel: string): void {
    this.channel = channel;
    // electron-updater allows downgrades once a channel is set. These channels
    // are builds of the same releases, so an older version is never wanted.
    this.allowDowngrade = false;
  }

  /** A release without this architecture's manifest still has the combined installer. */
  protected override async getUpdateInfoAndProvider(): Promise<UpdateInfoAndProvider> {
    try {
      return await super.getUpdateInfoAndProvider();
    } catch (error: unknown) {
      if (
        this.architectureChannel === null ||
        this.channel !== this.architectureChannel ||
        !isMissingFeedError(error)
      ) {
        throw error;
      }
      this._logger.warn(
        `The latest release has no ${this.architectureChannel}.yml; using ${COMBINED_WINDOWS_FEED_CHANNEL}.yml for this session.`,
      );
      this.follow(COMBINED_WINDOWS_FEED_CHANNEL);
      return await super.getUpdateInfoAndProvider();
    }
  }

  /** Resolves true when the installer must be downloaded whole. */
  protected override async differentialDownloadInstaller(
    fileInfo: ResolvedUpdateFileInfo,
    downloadUpdateOptions: DownloadUpdateOptions,
    installerPath: string,
    provider: Provider<UpdateInfo>,
    oldInstallerFileName: string,
  ): Promise<boolean> {
    const problem = await this.cachedInstallerProblem(
      fileInfo,
      downloadUpdateOptions,
      provider,
      oldInstallerFileName,
    );
    if (problem !== null) {
      this._logger.info(`Skipping the differential download: ${problem}.`);
      return true;
    }
    return super.differentialDownloadInstaller(
      fileInfo,
      downloadUpdateOptions,
      installerPath,
      provider,
      oldInstallerFileName,
    );
  }

  private async cachedInstallerProblem(
    fileInfo: ResolvedUpdateFileInfo,
    downloadUpdateOptions: DownloadUpdateOptions,
    provider: Provider<UpdateInfo>,
    oldInstallerFileName: string,
  ): Promise<string | null> {
    const cacheDir = this.downloadedUpdateHelper?.cacheDir;
    if (cacheDir === undefined) return null;
    try {
      return await differentialBaseProblem({
        installerPath: path.join(cacheDir, oldInstallerFileName),
        cachedBlockMapPath: path.join(cacheDir, CACHED_BLOCKMAP_FILE),
        fetchPublishedBlockMap: async () => {
          // The same URL electron-updater derives for the running version's blockmap.
          const [published] = await provider.getBlockMapFiles(
            fileInfo.url,
            this.app.version,
            downloadUpdateOptions.updateInfoAndProvider.info.version,
            this.previousBlockmapBaseUrlOverride,
          );
          if (published === undefined) throw new Error('The feed names no previous blockmap.');
          return this.downloadBlockMap(published);
        },
      });
    } catch (error: unknown) {
      // Leave the decision to electron-updater, whose own attempt still ends
      // in a verified installer.
      this._logger.warn(
        `Could not check the cached installer: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async downloadBlockMap(url: URL): Promise<Uint8Array> {
    const response = await this.netSession.fetch(url.href, {
      signal: AbortSignal.timeout(BLOCKMAP_DOWNLOAD_TIMEOUT_MS),
    });
    const declaredBytes = Number(response.headers.get('content-length') ?? 0);
    if (!response.ok || declaredBytes > MAX_COMPRESSED_BLOCKMAP_BYTES) {
      throw new Error(
        `${url.href} answered ${response.status} with ${declaredBytes} declared bytes.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
