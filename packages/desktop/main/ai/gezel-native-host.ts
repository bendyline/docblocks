import path from 'node:path';

/** Main-authoritative paths only; never accept a renderer-supplied engine path. */
export interface GezelNativeHost {
  readonly nativeBinDir?: string;
  readonly distributionProfile: 'standard' | 'store';
  readonly allowStandaloneMacPayload: boolean;
  readonly canHost: boolean;
}

export function resolveGezelNativeHost(
  isPackaged: boolean,
  resourcesPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): GezelNativeHost {
  if (isPackaged) {
    return {
      nativeBinDir: path.join(resourcesPath, 'gezel-native'),
      // All shipped builds use their bundled engines. Never repair a missing
      // payload by downloading executable code at runtime.
      distributionProfile: 'store',
      allowStandaloneMacPayload: false,
      // The pinned native release has no Intel Mac engine archives.
      canHost: platform !== 'darwin' || arch === 'arm64',
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

const ENGINE_OVERRIDES = [
  'GEZEL_NATIVE_ENGINE_VERSION',
  'GEZEL_LLAMA_SERVER_BIN',
  'GEZEL_DS4_SERVER_BIN',
  'GEZEL_SD_SERVER_BIN',
  'GEZEL_WHISPER_SERVER_BIN',
  'GEZEL_DEVICE_HEALTH_BIN',
  'GEZEL_APPLE_FM_BIN',
  'GEZEL_UV_BIN',
  'GEZEL_DUCKDB_BIN',
];

/** Keep ambient developer overrides from bypassing a packaged payload's pins. */
export function clearGezelEngineOverrides(env: NodeJS.ProcessEnv = process.env): () => void {
  const previous = new Map(ENGINE_OVERRIDES.map((key) => [key, env[key]]));
  for (const key of ENGINE_OVERRIDES) delete env[key];
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}
