interface ChromiumCommandLine {
  hasSwitch(name: string): boolean;
  appendSwitch(name: string, value?: string): void;
}

/**
 * Avoid Chromium probing the desktop keyring for a credential store DocBlocks
 * does not use. Git credentials remain owned by Git/gh, outside Electron.
 *
 * Keep an explicit launch override authoritative for users who intentionally
 * select a different Chromium backend.
 */
export function configureLinuxCredentialStorage(
  platform: NodeJS.Platform,
  commandLine: ChromiumCommandLine,
): void {
  if (platform !== 'linux' || commandLine.hasSwitch('password-store')) return;
  commandLine.appendSwitch('password-store', 'basic');
}
