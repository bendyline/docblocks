import path from 'node:path';

/**
 * Packaged Windows builds carry the Visual C++ runtime in `resources/vc-runtime`
 * (see `scripts/stage-vc-runtime.cjs`). Native engines and ONNX Runtime find it
 * through PATH, which the loader searches after the system directories, so a
 * serviced runtime already installed on the machine still takes precedence.
 *
 * Returns the PATH value to use, or null when nothing should change. Pure so it
 * can be tested off Windows; main applies it before spawning any engine.
 */
export function vcRuntimePath(
  isPackaged: boolean,
  resourcesPath: string,
  currentPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!isPackaged || platform !== 'win32') return null;
  const runtime = path.win32.join(resourcesPath, 'vc-runtime');
  const entries = (currentPath ?? '').split(';').filter(Boolean);
  if (entries.some((entry) => entry.toLowerCase() === runtime.toLowerCase())) return null;
  return [...entries, runtime].join(';');
}
