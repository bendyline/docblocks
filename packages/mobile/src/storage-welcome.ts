/**
 * Android's first-run welcome screen.
 *
 * Android grants lasting access to a shared folder only through its system
 * folder picker, and a first launch that opened straight into that picker
 * was jarring. Until the storage question is settled, this screen explains
 * it and opens the picker only when asked. Backing out of the picker, or
 * picking a folder that cannot be opened, brings the user back here to try
 * again. Once a folder is chosen the shell loads as on any other launch,
 * seeding the folder with the welcome document and showing its own first-run
 * screen, which then greets the user with FOLDER_READY_GREETING rather than
 * welcoming them a second time.
 *
 * The screen lives inside index.html's launch splash. It fades in from the
 * splash's brown, and it stays up (as "Opening DocBlocks…") until the shell
 * reports that startup has settled. Then dismissSplash fades it out along
 * with the splash, so the shell's interim states never show.
 */

import {
  parseMobileStorageDecided,
  parseMobileStorageOutcome,
} from '@bendyline/docblocks/host/mobile';
import { native, type MobilePlugin } from './native';
import { SPLASH_ID } from './splash';

export const STORAGE_WELCOME_CLASS = 'db-storage-welcome';
/** Set on the splash while it carries the welcome screen. */
export const SPLASH_WELCOME_CLASS = 'db-splash--welcome';

export const STORAGE_WELCOME_COPY = Object.freeze({
  title: 'Welcome to DocBlocks',
  summary:
    'Before we can get started, please select a folder that will hold all of your DocBlocks content.',
  recommendation: 'We recommend a DocBlocks folder in Documents, the default.',
  pick: 'Pick a folder…',
  opening: 'Opening DocBlocks…',
  cancelled:
    'DocBlocks needs a folder before it can open. In the picker, tap “Use this folder”, then “Allow”, to keep the DocBlocks folder in Documents.',
  failed: 'That folder could not be opened. Please pick it again, or choose a different folder.',
});

/**
 * What the shell's own first-run screen leads with when the user has just
 * picked their folder here, in place of a second "Welcome to DocBlocks".
 */
export const FOLDER_READY_GREETING = 'Your folder is ready';

let greeting: string | undefined;

/**
 * The shell's `firstRunGreeting` for this launch: FOLDER_READY_GREETING
 * once a folder was picked on the welcome screen, otherwise nothing, so the
 * shell keeps its own welcome.
 */
export function firstRunGreeting(): string | undefined {
  return greeting;
}

type StorageNative = Pick<
  MobilePlugin,
  'storageDecided' | 'chooseStorage' | 'releaseSplash' | 'backUnhandled'
>;

/**
 * Resolves once Android knows where documents live: at once when that was
 * settled on an earlier launch, otherwise after the user picks a folder from
 * the welcome screen (or, on a device with no folder picker, tries to).
 */
export async function ensureStorageChosen(bridge: StorageNative = native): Promise<void> {
  greeting = undefined;
  if (parseMobileStorageDecided(await bridge.storageDecided())) return;

  // The native splash would hide the screen. The page's splash under it is
  // identical, so letting it go first shows nothing changing.
  await bridge.releaseSplash().catch(() => undefined);
  const screen = mountStorageWelcome();

  // Back on this screen leaves the app, as it would from any first screen.
  const leave = () => void bridge.backUnhandled().catch(() => undefined);
  window.addEventListener('docblocksNativeBack', leave);
  try {
    for (;;) {
      await screen.nextPick();
      const outcome = parseMobileStorageOutcome(await bridge.chooseStorage());
      if (outcome === 'chosen' || outcome === 'device') {
        if (outcome === 'chosen') greeting = FOLDER_READY_GREETING;
        screen.opening();
        return;
      }
      screen.ready(STORAGE_WELCOME_COPY[outcome]);
    }
  } finally {
    window.removeEventListener('docblocksNativeBack', leave);
  }
}

interface StorageWelcomeScreen {
  /** Enables "Pick a folder…" and resolves when it is tapped, disabling it again. */
  nextPick(): Promise<void>;
  /** Back from the picker without a folder: say why, and offer it again. */
  ready(message: string): void;
  /** A folder is chosen: hold the screen while the shell loads beneath it. */
  opening(): void;
}

function mountStorageWelcome(): StorageWelcomeScreen {
  const splash = document.getElementById(SPLASH_ID) ?? createSplash();
  const { title, summary, recommendation, pick, opening } = STORAGE_WELCOME_COPY;

  const heading = element('h1', { id: 'db-storage-welcome-title', tabindex: '-1' }, title);
  const button = element(
    'button',
    { type: 'button', class: `${STORAGE_WELCOME_CLASS}-pick` },
    pick,
  );
  // Polite and always present, so a message written into it is announced.
  const status = element('p', { class: `${STORAGE_WELCOME_CLASS}-status`, role: 'status' });
  const body = element('div', { class: `${STORAGE_WELCOME_CLASS}-body` });
  // The splash's mark, drawn as the app icon the user just tapped.
  const icon = splash.querySelector('svg')?.cloneNode(true);
  if (icon instanceof Element) {
    icon.setAttribute('class', `${STORAGE_WELCOME_CLASS}-icon`);
    body.append(icon);
  }
  body.append(
    heading,
    element('p', {}, summary),
    element('p', { class: `${STORAGE_WELCOME_CLASS}-note` }, recommendation),
    button,
    status,
  );
  const screen = element('section', {
    class: STORAGE_WELCOME_CLASS,
    'aria-labelledby': heading.id,
  });
  screen.append(body);
  splash.append(screen);
  splash.classList.add(SPLASH_WELCOME_CLASS);
  heading.focus({ preventScroll: true });

  return {
    nextPick: () =>
      new Promise((resolve) => {
        button.disabled = false;
        button.addEventListener(
          'click',
          () => {
            button.disabled = true;
            status.textContent = '';
            resolve();
          },
          { once: true },
        );
      }),
    ready: (message) => {
      status.textContent = message;
    },
    opening: () => {
      button.disabled = true;
      button.textContent = opening;
    },
  };
}

/** index.html always ships the splash; this only keeps the screen up without it. */
function createSplash(): HTMLElement {
  const splash = element('div', { id: SPLASH_ID });
  document.body.append(splash);
  return splash;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
