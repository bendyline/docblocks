/**
 * The main → preload transport for the `HostEnvironment` values that only
 * the main process can know.
 *
 * `HostEnvironment` (packages/core/src/host/types.ts) is a *synchronous*
 * object: the renderer reads `getDocBlocksHost().env.appVersion` inline while
 * rendering, so the values must already exist when the preload builds the
 * contextBridge object. There is no point at which the renderer could await
 * them, which rules out an `ipcRenderer.invoke` channel.
 *
 * The preload is sandboxed (`sandbox: true` in main.ts) and a packaged app
 * inherits neither `npm_package_version` nor `NODE_ENV`, so the preload has no
 * honest local source for these. Only main does — `app.getVersion()` and
 * `app.isPackaged`. Main therefore stamps them onto the renderer's argv via
 * `webPreferences.additionalArguments`, which Electron appends to
 * `process.argv` in the renderer, and the preload decodes them here.
 *
 * Shared by main and preload, and included by both tsconfigs. Keep it pure:
 * no `electron`, no `node:*`, no ambient globals — that purity is what makes
 * it safe to load on both sides of the sandbox boundary.
 */

const APP_VERSION_SWITCH = '--docblocks-app-version=';
const IS_DEV_SWITCH = '--docblocks-is-dev=';

/**
 * Reported when main never stamped a version. Deliberately not '0.0.0': this
 * string reaches users through the About surface and the issue-report URL, and
 * a plausible-looking version is worse than an obviously absent one.
 */
const UNKNOWN_APP_VERSION = 'unknown';

export interface HostEnvironmentValues {
  appVersion: string;
  isDev: boolean;
}

/** Main-side: encode for `webPreferences.additionalArguments`. */
export function hostEnvironmentArguments(values: HostEnvironmentValues): string[] {
  return [
    `${APP_VERSION_SWITCH}${values.appVersion}`,
    `${IS_DEV_SWITCH}${values.isDev ? '1' : '0'}`,
  ];
}

/**
 * Last match wins. Electron *appends* `additionalArguments`, so the value main
 * stamped is always the final occurrence — an earlier look-alike inherited
 * from the command line can never shadow it.
 */
function switchValue(argv: readonly string[], prefix: string): string | undefined {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (argument.startsWith(prefix)) return argument.slice(prefix.length);
  }
  return undefined;
}

/** Preload-side: decode the main-owned values out of `process.argv`. */
export function parseHostEnvironmentArguments(argv: readonly string[]): HostEnvironmentValues {
  const appVersion = switchValue(argv, APP_VERSION_SWITCH);
  return {
    appVersion: appVersion ? appVersion : UNKNOWN_APP_VERSION,
    // Fail safe: only an explicit '1' is development. A missing or malformed
    // switch must never unlock development affordances in a packaged build.
    isDev: switchValue(argv, IS_DEV_SWITCH) === '1',
  };
}
