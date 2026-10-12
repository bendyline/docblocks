import policy from '../native-platform-policy.json';

export interface NativePlatformVersions {
  readonly macOS?: string;
  readonly glibc?: string;
}

/** Read runtime metadata only: never load a binding or launch an engine to probe it. */
export function nativePlatformVersions(): NativePlatformVersions {
  try {
    if (process.platform === 'darwin')
      return typeof process.getSystemVersion === 'function'
        ? { macOS: process.getSystemVersion() }
        : {};
    if (process.platform !== 'linux') return {};
    const report: unknown = process.report?.getReport();
    if (typeof report !== 'object' || report === null || !('header' in report)) return {};
    const header = report.header;
    if (typeof header !== 'object' || header === null || !('glibcVersionRuntime' in header))
      return {};
    return typeof header.glibcVersionRuntime === 'string'
      ? { glibc: header.glibcVersionRuntime }
      : {};
  } catch {
    return {};
  }
}

function atLeast(actual: string | undefined, minimum: string): boolean {
  if (!actual || !/^\d+\.\d+(?:\.\d+)?$/u.test(actual)) return false;
  const parts = actual.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (parts[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** Undefined means the bundled llama/Whisper payload can meet the host's OS ABI. */
export function bundledNativeUnavailableReason(
  platform: NodeJS.Platform,
  versions: NativePlatformVersions,
): string | undefined {
  if (platform === 'darwin' && !atLeast(versions.macOS, policy.macNativeMinimum)) {
    return `Built-in AI and dictation need macOS ${policy.macNativeMinimum.replace(/\.0$/u, '')} or later. You can still edit and export documents.`;
  }
  if (platform === 'linux' && !atLeast(versions.glibc, policy.linuxNativeGlibcMinimum)) {
    return `Built-in AI and dictation need Linux with glibc ${policy.linuxNativeGlibcMinimum} or later, such as Ubuntu 24.04 or Debian 13. You can still edit and export documents.`;
  }
  return undefined;
}
