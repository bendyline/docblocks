/**
 * Intel Mac end of support.
 *
 * DocBlocks' bundled AI and speech engines have no Intel builds, so
 * `intel-mac-final.json` names the last version built for Intel Macs. That
 * release published an x64 update, and release CI keeps every later
 * `latest-mac.yml` pointing Intel Macs back at it
 * (`scripts/intel-mac-final-feed.ts`). That build must never ask for another
 * update: newer feeds carry nothing an Intel Mac can install, and
 * electron-updater reports each attempt as a download failure.
 *
 * x64 builds translated by Rosetta on Apple silicon are not affected. They keep
 * updating, and electron-updater moves them to the native arm64 build.
 *
 * Electron-free so the policy is unit-testable; `updater.ts` owns the dialogs.
 */

import policy from '../intel-mac-final.json';

export const INTEL_MAC_FINAL_VERSION: string = policy.version;

export interface MacHostIdentity {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** `app.runningUnderARM64Translation`: an x64 build on Apple silicon. */
  readonly translated: boolean;
}

export function isUnsupportedIntelMac(host: MacHostIdentity): boolean {
  return host.platform === 'darwin' && host.arch === 'x64' && !host.translated;
}

export const INTEL_MAC_FINAL_NOTICE = {
  title: 'DocBlocks for Intel Macs',
  message: `DocBlocks ${INTEL_MAC_FINAL_VERSION} is the final version for Intel Macs.`,
  detail:
    'DocBlocks keeps working on this Mac, but it won’t receive further updates. ' +
    'Newer versions require a Mac with Apple silicon. Built-in AI, dictation, and read ' +
    'aloud aren’t available on Intel Macs.',
} as const;
