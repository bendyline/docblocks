import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'chai';
import { dismissSplash, SPLASH_ID } from '../src/splash.js';
import {
  ensureStorageChosen,
  firstRunGreeting,
  FOLDER_READY_GREETING,
  SPLASH_WELCOME_CLASS,
  STORAGE_WELCOME_CLASS,
  STORAGE_WELCOME_COPY,
} from '../src/storage-welcome.js';

const INDEX_HTML = path.join(process.cwd(), 'packages/mobile/index.html');

async function mountShippedSplash(): Promise<HTMLElement> {
  const html = await readFile(INDEX_HTML, 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/u)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gu, '');
  return document.getElementById(SPLASH_ID)!;
}

type Outcome = 'chosen' | 'device' | 'cancelled' | 'failed';

/** DocBlocksMobilePlugin's storage calls, answering with the outcomes given in turn. */
function fakeNative(decided: boolean, outcomes: Outcome[] = []) {
  const calls: string[] = [];
  return {
    calls,
    bridge: {
      storageDecided: async () => {
        calls.push('storageDecided');
        return { decided };
      },
      chooseStorage: async () => {
        calls.push('chooseStorage');
        const outcome = outcomes.shift();
        if (!outcome) throw new Error('No picker outcome scripted.');
        return { outcome };
      },
      releaseSplash: async () => {
        calls.push('releaseSplash');
      },
      backUnhandled: async () => {
        calls.push('backUnhandled');
      },
    },
  };
}

/** Lets pending bridge promises and the welcome loop run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function screen() {
  const root = document.querySelector<HTMLElement>(`.${STORAGE_WELCOME_CLASS}`);
  return {
    root,
    pick: root?.querySelector<HTMLButtonElement>(`.${STORAGE_WELCOME_CLASS}-pick`) ?? null,
    status: root?.querySelector(`.${STORAGE_WELCOME_CLASS}-status`) ?? null,
  };
}

describe('Android first-run welcome screen', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('stays out of the way once the storage question is settled', async () => {
    const splash = await mountShippedSplash();
    const { bridge, calls } = fakeNative(true);
    await ensureStorageChosen(bridge);
    expect(calls).to.deep.equal(['storageDecided']);
    expect(screen().root).to.equal(null);
    // Nothing greeted the user, so the shell keeps its own welcome.
    expect(firstRunGreeting()).to.equal(undefined);
    expect(splash.classList.contains(SPLASH_WELCOME_CLASS)).to.equal(false);
  });

  it('explains the folder before any picker opens, over the page splash', async () => {
    const splash = await mountShippedSplash();
    const { bridge, calls } = fakeNative(false, ['chosen']);
    const chosen = ensureStorageChosen(bridge);
    await settle();

    // The native splash steps aside; nothing has asked for a folder yet.
    expect(calls).to.deep.equal(['storageDecided', 'releaseSplash']);
    const { root, pick } = screen();
    expect(root?.parentElement).to.equal(splash);
    expect(splash.classList.contains(SPLASH_WELCOME_CLASS)).to.equal(true);
    expect(root?.getAttribute('aria-labelledby')).to.equal('db-storage-welcome-title');
    expect(root?.querySelector('h1')?.textContent).to.equal('Welcome to DocBlocks');
    expect(root?.textContent).to.contain(STORAGE_WELCOME_COPY.summary);
    expect(root?.textContent).to.contain(STORAGE_WELCOME_COPY.recommendation);
    expect(pick?.textContent).to.equal('Pick a folder…');
    expect(pick?.disabled).to.equal(false);
    // The splash's mark comes along as the app icon, hidden from assistive technology.
    expect(root?.querySelector('svg')?.getAttribute('aria-hidden')).to.equal('true');

    pick!.click();
    await chosen;
    expect(calls).to.deep.equal(['storageDecided', 'releaseSplash', 'chooseStorage']);
  });

  it('holds the screen while the shell loads, then leaves with the splash', async () => {
    const splash = await mountShippedSplash();
    const { bridge } = fakeNative(false, ['chosen']);
    const chosen = ensureStorageChosen(bridge);
    await settle();
    screen().pick!.click();
    await chosen;

    const { root, pick } = screen();
    expect(root?.isConnected).to.equal(true);
    expect(pick?.disabled).to.equal(true);
    expect(pick?.textContent).to.equal('Opening DocBlocks…');

    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
    })) as unknown as typeof window.matchMedia;
    try {
      dismissSplash();
    } finally {
      window.matchMedia = original;
    }
    expect(splash.isConnected).to.equal(false);
    expect(root?.isConnected).to.equal(false);
  });

  it('comes back, with a hint, when the user backs out of the picker', async () => {
    await mountShippedSplash();
    const { bridge, calls } = fakeNative(false, ['cancelled', 'chosen']);
    let done = false;
    const chosen = ensureStorageChosen(bridge).then(() => {
      done = true;
    });
    await settle();

    screen().pick!.click();
    expect(screen().pick?.disabled, 'no second picker while one is open').to.equal(true);
    await settle();
    expect(done).to.equal(false);
    expect(screen().pick?.disabled).to.equal(false);
    expect(screen().pick?.textContent).to.equal('Pick a folder…');
    expect(screen().status?.textContent).to.equal(STORAGE_WELCOME_COPY.cancelled);

    screen().pick!.click();
    await chosen;
    expect(calls.filter((call) => call === 'chooseStorage')).to.have.length(2);
    expect(screen().status?.textContent).to.equal('');
  });

  it('says so when the picked folder cannot be opened, and offers the picker again', async () => {
    await mountShippedSplash();
    const { bridge } = fakeNative(false, ['failed', 'chosen']);
    const chosen = ensureStorageChosen(bridge);
    await settle();

    screen().pick!.click();
    await settle();
    expect(screen().status?.textContent).to.equal(STORAGE_WELCOME_COPY.failed);
    expect(screen().pick?.disabled).to.equal(false);

    screen().pick!.click();
    await chosen;
  });

  it('leaves the app on Back while it waits, and hands Back to the shell afterwards', async () => {
    await mountShippedSplash();
    const { bridge, calls } = fakeNative(false, ['chosen']);
    const chosen = ensureStorageChosen(bridge);
    await settle();

    window.dispatchEvent(new Event('docblocksNativeBack'));
    await settle();
    expect(calls).to.include('backUnhandled');

    screen().pick!.click();
    await chosen;
    calls.length = 0;
    window.dispatchEvent(new Event('docblocksNativeBack'));
    await settle();
    expect(calls).to.deep.equal([]);
  });

  it('moves the shell past its own welcome once a folder is picked', async () => {
    await mountShippedSplash();
    const { bridge } = fakeNative(false, ['chosen']);
    const chosen = ensureStorageChosen(bridge);
    await settle();
    expect(firstRunGreeting(), 'not before the folder is picked').to.equal(undefined);
    screen().pick!.click();
    await chosen;
    expect(firstRunGreeting()).to.equal(FOLDER_READY_GREETING);
    expect(FOLDER_READY_GREETING).to.equal('Your folder is ready');
  });

  it('opens on device storage, still welcomed by the shell, where no folder picker exists', async () => {
    await mountShippedSplash();
    const { bridge } = fakeNative(false, ['device']);
    const chosen = ensureStorageChosen(bridge);
    await settle();
    screen().pick!.click();
    await chosen;
    expect(screen().pick?.textContent).to.equal('Opening DocBlocks…');
    expect(firstRunGreeting()).to.equal(undefined);
  });

  it('passes on a storage failure instead of waiting forever', async () => {
    await mountShippedSplash();
    const { bridge } = fakeNative(false, []);
    const chosen = ensureStorageChosen(bridge);
    await settle();
    screen().pick!.click();
    let failure: unknown;
    await chosen.catch((error: unknown) => {
      failure = error;
    });
    expect(failure).to.be.instanceOf(Error);
  });

  it('rejects a malformed answer from native', async () => {
    await mountShippedSplash();
    const { bridge } = fakeNative(false);
    bridge.storageDecided = async () => ({ decided: 'no' }) as unknown as { decided: boolean };
    let failure: unknown;
    await ensureStorageChosen(bridge).catch((error: unknown) => {
      failure = error;
    });
    expect(failure).to.be.instanceOf(Error);
    expect(screen().root).to.equal(null);
  });
});
