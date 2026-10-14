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

export function resolveGezelNativeHost(
  isPackaged: boolean,
  resourcesPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  macAppStore = false,
  versions: NativePlatformVersions = nativePlatformVersions(),
): GezelNativeHost {
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
  return {
    ...(configured ? { nativeBinDir: configured } : {}),
    distributionProfile: 'standard',
    allowStandaloneMacPayload: true,
    canHost: true,
  };
}
