import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveGezelNativeHost } from '../ai/gezel-native-host.js';
import type { NativePlatformVersions } from '../native-platform.js';

interface WhisperLocationOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  macAppStore?: boolean;
  versions?: NativePlatformVersions;
  exists?: (file: string) => boolean;
}

/** Find files only: discovery never starts Gezel or downloads an engine. */
export function findWhisperBinary(options: WhisperLocationOptions): string | null {
  const { platform, arch } = options;
  const exists = options.exists ?? existsSync;
  const native = resolveGezelNativeHost({ ...options, exists });
  // The bundled or staged payload is authoritative. Never fall through to
  // another app's engine, or to one Gezel downloaded for itself.
  if (!native.canHost || !native.nativeBinDir) return null;
  const name = platform === 'win32' ? 'gezel-whisper-server.exe' : 'gezel-whisper-server';
  const binary = path.join(native.nativeBinDir, `${platform}-${arch}`, name);
  return exists(binary) ? binary : null;
}
