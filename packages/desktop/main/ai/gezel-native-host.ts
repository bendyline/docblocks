import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  bundledNativeUnavailableReason,
  nativePlatformVersions,
  type NativePlatformVersions,
} from '../native-platform.js';

/** Main-authoritative paths only; never accept a renderer-supplied engine path. */
export interface GezelNativeHost {
  readonly nativeBinDir?: string;
  readonly distributionProfile: 'standard' | 'store';
  readonly allowStandaloneMacPayload: boolean;
  readonly canHost: boolean;
  readonly unavailableReason?: string;
  /** MAS payloads are re-signed and authenticated by the enclosing store app. */
  readonly macAppStore?: boolean;
}

export interface GezelNativeHostInput {
  readonly isPackaged: boolean;
  /** Packaged builds ship their engines in `<resources>/gezel-native`. */
  readonly resourcesPath: string;
  /** The desktop package; source builds run the engines staged in its `dist`. */
  readonly appPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly macAppStore?: boolean;
  readonly versions?: NativePlatformVersions;
  readonly exists?: (file: string) => boolean;
}

/** electron-builder's `${os}`, which names the staged folder packaging copies. */
const BUILDER_OS: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'win',
  darwin: 'mac',
  linux: 'linux',
};

/**
 * Where `npm run stage:gezel-native` puts this machine's engines: the folder
 * packaging copies into the app, so a source build runs what ships.
 */
export function stagedNativeBinDir(
  appPath: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  return path.join(appPath, 'dist', 'gezel-native', `${BUILDER_OS[platform] ?? platform}-${arch}`);
}

export const UNSTAGED_NATIVE_REASON =
  'This development build has no staged engines for built-in AI and dictation. Run `npm run stage:gezel-native` in the DocBlocks repository, then restart DocBlocks.';

export function resolveGezelNativeHost(input: GezelNativeHostInput): GezelNativeHost {
  const {
    isPackaged,
    resourcesPath,
    appPath,
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    macAppStore = false,
    versions = nativePlatformVersions(),
    exists = existsSync,
  } = input;
  if (isPackaged) {
    const unavailableReason = bundledNativeUnavailableReason(platform, versions);
    return {
      nativeBinDir: path.join(resourcesPath, 'gezel-native'),
      // All shipped builds use their bundled engines. Never repair a missing
      // payload by downloading executable code at runtime.
      distributionProfile: 'store',
      allowStandaloneMacPayload: false,
      // The pinned native release has no Intel Mac engine archives.
      canHost: !unavailableReason && (platform !== 'darwin' || arch === 'arm64'),
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(macAppStore ? { macAppStore: true } : {}),
    };
  }
  const configured = env.DOCBLOCKS_GEZEL_NATIVE_BIN_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error('DOCBLOCKS_GEZEL_NATIVE_BIN_DIR must be an absolute path.');
  }
  // Automated runs host Gezel without engines and never run a model, so they
  // stay independent of whatever the developer has staged.
  if (!configured && env.DOCBLOCKS_E2E_DEFAULT_ROOT) {
    return { distributionProfile: 'standard', allowStandaloneMacPayload: true, canHost: true };
  }
  // Like a shipped build: run the staged engines, and never download one.
  const nativeBinDir = configured || stagedNativeBinDir(appPath, platform, arch);
  const staged = exists(path.join(nativeBinDir, 'release.json'));
  return {
    nativeBinDir,
    distributionProfile: 'store',
    allowStandaloneMacPayload: true,
    canHost: staged,
    ...(staged ? {} : { unavailableReason: UNSTAGED_NATIVE_REASON }),
  };
}
