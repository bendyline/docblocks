import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveGezelNativeHost } from '../ai/gezel-native-host.js';

interface WhisperLocationOptions {
  isPackaged: boolean;
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  nativeRelease: string;
  macAppStore?: boolean;
  exists?: (file: string) => boolean;
}

/** Find files only: discovery never starts Gezel or downloads an engine. */
export function findWhisperBinary(options: WhisperLocationOptions): string | null {
  const { isPackaged, resourcesPath, env, platform, arch, home, nativeRelease } = options;
  const native = resolveGezelNativeHost(
    isPackaged,
    resourcesPath,
    env,
    platform,
    arch,
    options.macAppStore,
  );
  if (!native.canHost) return null;
  const exists = options.exists ?? existsSync;
  const name = platform === 'win32' ? 'gezel-whisper-server.exe' : 'gezel-whisper-server';
  const binaryIn = (directory: string) => path.join(directory, `${platform}-${arch}`, name);
  // Packaged builds and explicit overrides are authoritative. Never fall
  // through to another app's engine when their configured payload is missing.
  if (native.nativeBinDir) {
    const binary = binaryIn(native.nativeBinDir);
    return exists(binary) ? binary : null;
  }
  if (isPackaged || options.macAppStore) return null;

  const configuredHome = env.GEZEL_HOME?.trim();
  if (configuredHome && !path.isAbsolute(configuredHome)) return null;
  // Tests must not discover the developer's own downloads.
  if (!configuredHome && env.DOCBLOCKS_E2E_DEFAULT_ROOT) return null;
  const gezelHome = configuredHome || path.join(home, '.gezel');
  // In source builds, reuse an already installed engine at the exact release
  // pinned by the installed service. Never scan for arbitrary/older versions.
  for (const root of [path.join(gezelHome, 'apps', 'docblocks'), gezelHome]) {
    const binary = binaryIn(path.join(root, 'engines', 'native-bin', nativeRelease));
    if (exists(binary)) return binary;
  }
  return null;
}
