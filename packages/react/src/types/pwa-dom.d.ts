/**
 * Ambient declarations for PWA browser APIs that TypeScript's lib.dom does
 * not ship yet: the Chromium install-prompt event and the launchQueue
 * file-handling API. Both are Chromium-only — always feature-detect before
 * use; on other engines the events simply never fire and `launchQueue` is
 * undefined.
 */

interface BeforeInstallPromptEvent extends Event {
  /** Shows the browser install prompt. Callable at most once per event. */
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface LaunchParams {
  readonly files: ReadonlyArray<FileSystemFileHandle>;
  readonly targetURL?: string;
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

interface Window {
  launchQueue?: LaunchQueue;
}

interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
  appinstalled: Event;
}
