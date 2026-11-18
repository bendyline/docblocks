import type { ConsoleMessage, Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

/**
 * A finger cannot hover, so on a phone or tablet a squiggle answers a tap: the
 * tap raises the proofing card, and the card's buttons fix the word.
 *
 * The WebKit projects stand in for iPhone and iPad, where this once failed
 * outright: WebKit reports a finger's click as `pointerType: "mouse"`, so
 * every tap read as a mouse click and no card appeared. The Source view's tap
 * card is covered upstream, in Squisq's `e2e/proofing-touch.spec.ts`.
 */

const squiggle = (page: Page) => page.locator('.tiptap [data-proof-id]', { hasText: /^teh$/ });
const card = (page: Page) => page.locator('.squisq-proof-tooltip');

/** Fresh starts allowed when harper's engine crashes. */
const ENGINE_ATTEMPTS = 3;

/** A WASM trap as WebKit words it. */
const WASM_TRAP = /RuntimeError: .*\(evaluating 'wasm(?:\$1)?\./u;

/**
 * Watch for harper's engine crashing. Under parallel load WebKit's WASM traps
 * (upstream harper.js defects, allowed in console-guard.ts), and harper
 * catches none of them, so the request in flight is never answered and
 * proofing on that page stops for good: in the lint worker (its inlined blob:
 * script) it stays at "Proofing…"; on the page, rebuilding a lint the worker
 * sent, it reads "✓ Proofing" and draws nothing. The page's own copy failing
 * to start is fatal only once the page uses it, so it alone ends no wait, but
 * a test that fails after it starts over all the same.
 */
function watchEngine(page: Page) {
  let crash: string | undefined;
  let fatal: string | undefined;
  const onConsole = (message: ConsoleMessage) => {
    const text = message.text();
    if (message.type() !== 'error' || !message.location().url.startsWith('blob:')) return;
    if (!WASM_TRAP.test(text)) return;
    crash ??= text;
    fatal ??= text;
  };
  const onPageError = (error: Error) => {
    const text = error.stack || `${error.name}: ${error.message}`;
    if (!WASM_TRAP.test(text) || !text.includes('/harper__js.js')) return;
    crash ??= text;
    if (!text.includes('__wbindgen_start')) fatal ??= text;
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return {
    crash: () => crash,
    fatal: () => fatal,
    stop: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

/** End a wait at once when the engine has crashed for good. */
function throwIfCrashed(fatal: () => string | undefined): void {
  const crashed = fatal();
  if (crashed !== undefined) throw new Error(`harper's engine crashed: ${crashed}`);
}

/**
 * Start over as a first visit would: no saved documents, no settings, so the
 * welcome screen shows and the welcome document is unedited. A static file on
 * the app's origin holds no database open, so nothing blocks the deletes.
 */
async function forgetEverything(page: Page): Promise<void> {
  await page.goto('/THIRD_PARTY_NOTICES.txt');
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const names = (await indexedDB.databases()).flatMap((db) => (db.name ? [db.name] : []));
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          }),
      ),
    );
  });
}

/**
 * Open the welcome document in Write with a misspelling just under its title,
 * and wait for its squiggle. When harper's worker crashes on the way, that
 * page will never proof again, so start over on a fresh one: the test is about
 * taps, and harper's crash is upstream's to fix.
 */
async function openWriteWithTypo(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const engine = watchEngine(page);
    try {
      if (attempt > 1) await forgetEverything(page);
      await typeProbe(page);
      await waitForSquiggle(page, engine.fatal);
      return;
    } catch (error) {
      const crash = engine.crash();
      if (crash === undefined || attempt === ENGINE_ATTEMPTS) throw error;
      test.info().annotations.push({
        type: 'harper engine crashed',
        description: `Attempt ${attempt}: ${crash.split('\n')[0]} Started over on a fresh page.`,
      });
    } finally {
      engine.stop();
    }
  }
}

/** Open the welcome document in Write and type a misspelling under its title. */
async function typeProbe(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.db-shell')).toBeVisible();
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  const editor = page.locator('.tiptap[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  // The welcome screen leaves the editor inert, and visible, until its close
  // commits, and focus cannot enter an inert subtree. A caret placed before
  // then never reaches ProseMirror, and when the shell focuses the editor a
  // moment later ProseMirror puts the caret back at the start of the document.
  await expect
    .poll(() => editor.evaluate((element) => element.closest('[inert]') === null))
    .toBe(true);
  const heading = page.locator('.tiptap h1').first();
  // ProseMirror learns of a caret placed from script only through the
  // selectionchange event, and does not read the DOM caret again when a key
  // goes down: Enter pressed before the event arrives splits the title at
  // ProseMirror's own caret, the start of the document, and the probe is typed
  // into the title. On a busy page WebKit delivers the event hundreds of
  // milliseconds late, and until then ProseMirror can also write its own caret
  // back over this one (20 ms after the editor takes focus, or on a redraw).
  // So wait for the event, then check that the caret held; place it again if
  // it did not.
  await expect(async () => {
    const held = await heading.evaluate(async (title) => {
      const delivered = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        document.addEventListener(
          'selectionchange',
          () => {
            clearTimeout(timer);
            // ProseMirror re-adds its listener after every redraw, so it can
            // run after this one; and its focus check runs 20 ms after focus.
            setTimeout(() => resolve(true), 50);
          },
          { once: true },
        );
      });
      (title.closest('[contenteditable="true"]') as HTMLElement).focus();
      // The end of the title's own text: the template badges after it are not
      // editable, and a caret beyond them is one ProseMirror has to move.
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentElement?.closest('[contenteditable="false"]')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      let text: Node | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) text = node;
      const selection = window.getSelection();
      if (!text || !selection) return false;
      const end = document.createRange();
      end.setStart(text, text.textContent?.length ?? 0);
      end.collapse(true);
      selection.removeAllRanges();
      selection.addRange(end.cloneRange());
      if (!(await delivered) || selection.rangeCount === 0) return false;
      const caret = selection.getRangeAt(0);
      return (
        caret.collapsed &&
        title.contains(caret.startContainer) &&
        caret.compareBoundaryPoints(Range.START_TO_START, end) >= 0
      );
    });
    expect(held, 'the caret holds at the end of the title').toBe(true);
  }).toPass({ timeout: 30_000 });
  await expect(editor).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('This is teh probe.');
  // Its own paragraph under the title: typed into the title instead, the probe
  // draws no squiggle, and the wait below would time out without saying why.
  await expect(editor.locator('p', { hasText: /^This is teh probe\.$/ })).toBeVisible();
  await expect(heading).not.toContainText('probe');
  await editor.blur();
}

/** Wait for the probe's squiggle to show and hold still. */
async function waitForSquiggle(page: Page, fatal: () => string | undefined): Promise<void> {
  // Cold engine setup precedes the first squiggle. It takes about a second, so
  // "Proofing…" a minute on means it never will: harper's worker swallows a
  // failed start (a WebKit WASM trap, a failed fetch of the binary) and leaves
  // the page waiting. runtime-errors.json beside the failure holds the trap.
  // A crash the page reports ends either wait at once.
  const status = page.locator('.squisq-proof-status');
  await expect
    .poll(async () => (fatal() ? 'crashed' : ((await status.textContent()) ?? '').trim()), {
      message: 'the proofing engine starts',
      timeout: 60_000,
    })
    .toMatch(/^(✓ Proofing|\d+ issues?|crashed)$/u);
  throwIfCrashed(fatal);
  await expect
    .poll(
      async () =>
        fatal() ? 'crashed' : (await squiggle(page).isVisible()) ? 'squiggled' : 'waiting',
      { message: 'the probe is squiggled', timeout: 30_000 },
    )
    .toMatch(/^(squiggled|crashed)$/u);
  throwIfCrashed(fatal);
  // The edit sets off more than one pass, and each re-issues the finding's id
  // and redraws its squiggle. A tap across a redraw lands on no squiggle, so
  // wait until the id holds for longer than the 450 ms lint debounce.
  let lastId: string | null = null;
  await expect
    .poll(
      async () => {
        const id = await squiggle(page).getAttribute('data-proof-id');
        const settled = id !== null && id === lastId;
        lastId = id;
        return settled;
      },
      { intervals: [1_000], timeout: 30_000 },
    )
    .toBe(true);
  // Mid-screen, clear of the toolbar above and the status bar below.
  await squiggle(page).evaluate((word) => word.scrollIntoView({ block: 'center' }));
}

test.describe('Proofing squiggles on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('a tap on a squiggle raises its card, and a second tap puts it away', async ({ page }) => {
    test.setTimeout(120_000);
    await openWriteWithTypo(page);

    await squiggle(page).tap();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-trigger', 'tap');
    await expect(card(page).getByRole('button', { name: 'Ignore', exact: true })).toBeVisible();

    await squiggle(page).tap();
    await expect(card(page)).toHaveCount(0);
  });

  test('a suggestion on the card fixes the word', async ({ page }) => {
    test.setTimeout(120_000);
    await openWriteWithTypo(page);

    await squiggle(page).tap();
    await card(page).getByRole('button', { name: 'the', exact: true }).tap();
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('.tiptap')).toContainText('This is the probe.');
    await expect(squiggle(page)).toHaveCount(0);
  });
});
