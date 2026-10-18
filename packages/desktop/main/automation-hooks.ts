import fs from 'node:fs';
import path from 'node:path';

/**
 * Automated test runs set `DOCBLOCKS_E2E_DEFAULT_ROOT`. In every build that
 * isolates the run — its workspace, speech state and protocol registration —
 * so a suite never touches the user's real documents or link handler, even
 * when it targets a release package.
 *
 * Two hooks also relax a security prompt: the screen-capture picker and the
 * permission-probe window. Those need a build made for automation as well:
 * an unpackaged development run, or a package from `npm run dist:dir`, which
 * stamps `docblocksAutomationHooks` into app.asar's package.json. Release
 * packages never carry the stamp, and ASAR integrity keeps it from being added
 * afterwards, so their environment cannot skip either prompt.
 */
export const AUTOMATION_PACKAGE_FLAG = 'docblocksAutomationHooks';

export function automationRequested(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DOCBLOCKS_E2E_DEFAULT_ROOT);
}

/** True when the package.json carries the stamp electron-builder writes for `dist:dir`. */
export function hasAutomationStamp(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false;
  const value = (manifest as Record<string, unknown>)[AUTOMATION_PACKAGE_FLAG];
  // electron-builder's `-c.extraMetadata.<key>=true` may arrive as a string.
  return value === true || value === 'true';
}

/** Reads the app's own package.json (inside app.asar when packaged). */
export function readAppManifest(
  appPath: string,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): unknown {
  try {
    return JSON.parse(readFile(path.join(appPath, 'package.json'))) as unknown;
  } catch {
    return null;
  }
}

export function automationPrivilegesAllowed(options: {
  requested: boolean;
  isPackaged: boolean;
  manifest: unknown;
}): boolean {
  if (!options.requested) return false;
  return !options.isPackaged || hasAutomationStamp(options.manifest);
}
