/**
 * Theme parity between VS Code and the DocBlocks webview.
 *
 * Intent under test: VS Code dark => DocBlocks dark, VS Code light =>
 * DocBlocks light, from the first painted frame, with no flash.
 *
 * The "no flash" half is why these tests record a *history* of `data-theme`
 * rather than sampling it once at the end. The webview used to mount on a
 * hardcoded `dark` and correct itself when the host's `themeChange` arrived,
 * so a final-value assertion passes on both the fixed and the broken code.
 * Only the history distinguishes them.
 *
 * The recorder samples on every animation frame, which is exactly the "painted
 * frame" the intent talks about: rAF runs before paint, so any theme that
 * reaches the screen is seen. It cannot use a MutationObserver on
 * `documentElement` — VS Code builds the webview's inner frame with
 * `document.open()`, which throws away the observed node (and any observer
 * bound to it) while leaving `window` intact. The timer/rAF loops survive that
 * replacement; a MutationObserver does not, and silently records nothing.
 *
 * The live-switch test below keeps the pair honest: it asserts the recorder
 * captures a mid-life theme flip, so a history without "dark" in the
 * first-paint test means dark never rendered, not that the instrument is dead.
 */

import { test, expect, type Page, type Frame } from '@playwright/test';

declare global {
  interface Window {
    __dbThemeLog?: string[];
  }
}

const THEME_LOG_INIT = () => {
  if (window.__dbThemeLog) return;
  const log: string[] = [];
  window.__dbThemeLog = log;

  const record = () => {
    // This runs in every frame, including VS Code's workbench, whose DOM is
    // huge. Gate on an O(1) id lookup — only the webview mounts React into
    // #root — so the selector scan never touches the workbench. Sampling the
    // whole document instead measurably slows VS Code's cold boot, to the
    // point of pushing the editor past this spec's mount timeout.
    const root = document.getElementById('root');
    if (!root) return;
    const shell = root.querySelector('.db-shell[data-theme]');
    const value = shell?.getAttribute('data-theme');
    // Collapse repeats: only transitions are interesting.
    if (value && log[log.length - 1] !== value) log.push(value);
  };

  // rAF fires before paint, so it sees every theme that reaches the screen.
  // The slow interval is a backstop for a frame that is not painting.
  const onFrame = () => {
    record();
    requestAnimationFrame(onFrame);
  };
  setInterval(record, 50);
  requestAnimationFrame(onFrame);
};

async function waitForVSCode(page: Page) {
  await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  await page.waitForSelector('.activitybar', { timeout: 15_000 });
}

/**
 * Drive VS Code's own theme picker, so the theme changes the way a user
 * changes it. Ctrl+K Ctrl+T opens the picker directly — going through the
 * command palette is unreliable, because "Preferences: Color Theme" does not
 * sort first against its own name ("Browse Color Themes in Marketplace" wins)
 * and the wrong command gets invoked.
 *
 * Focus has to leave the editor first. Once the DocBlocks webview holds focus
 * it swallows the Ctrl+K prefix, and the lone Ctrl+T then opens "Go to Symbol"
 * — which looks enough like a quick pick to fail confusingly later. The
 * activity bar's empty lower region is inert: it takes focus without toggling
 * a view or opening a file.
 */
async function selectColorTheme(page: Page, themeName: string) {
  await page.locator('.activitybar').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+K');
  await page.keyboard.press('Control+T');

  const input = page.locator('.quick-input-widget input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(themeName);

  const themeRow = page.locator('.quick-input-list .monaco-list-row', { hasText: themeName });
  await themeRow.first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.quick-input-widget')).toBeHidden({ timeout: 10_000 });
}

/**
 * The webview's inner frame is the only one that ever mounts `.db-shell`, but
 * a raw `frame.evaluate` race against it is not safe: probing a frame while
 * VS Code is still navigating it can hang rather than reject, which no
 * `.catch` recovers from and which stalls a poll until it times out.
 *
 * So wait through the frame-locator chain first — it handles navigation
 * properly — and only resolve the `Frame` handle once the shell is settled.
 * The handle is needed because the recorded theme log lives on that frame's
 * `window`, which only `evaluate` can read.
 */
async function findEditorFrame(page: Page): Promise<Frame> {
  const webview = page.locator('iframe.webview').last();
  await webview.waitFor({ state: 'attached', timeout: 30_000 });
  const shell = webview
    .contentFrame()
    .locator('iframe#active-frame')
    .contentFrame()
    .locator('.db-shell[data-theme]');
  await shell.waitFor({ timeout: 30_000 });

  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          const hasShell = await frame
            .evaluate(() => Boolean(document.querySelector('.db-shell[data-theme]')))
            .catch(() => false);
          if (hasShell) {
            found = frame;
            return true;
          }
        }
        return false;
      },
      { timeout: 15_000, message: 'the DocBlocks editor shell never mounted in any frame' },
    )
    .toBe(true);
  return found as Frame;
}

async function readThemeLog(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => window.__dbThemeLog ?? []);
}

/**
 * Read the history once it has caught up to `expected` entries.
 *
 * The read itself races the webview: VS Code can re-navigate that frame, which
 * re-runs the init script and empties the log, so a single read can land in
 * the gap before the recorder ticks again and see `[]`. Waiting for the
 * expected length does not soften what is being tested — the caller still
 * asserts the *whole* history, and an extra "dark" makes the log non-empty
 * immediately rather than hiding.
 */
async function readSettledThemeLog(frame: Frame, expected: number): Promise<string[]> {
  await expect
    .poll(async () => (await readThemeLog(frame)).length, {
      timeout: 10_000,
      message: 'the theme recorder never reported a painted theme',
    })
    .toBeGreaterThanOrEqual(expected);
  return readThemeLog(frame);
}

/**
 * Open the fixture, and confirm it actually opened.
 *
 * The click is retried rather than fired once, because changing the color
 * theme re-renders the workbench: a click that lands during that re-render is
 * silently dropped, no editor opens, and the failure only surfaces much later
 * as "the shell never mounted". Retrying until a webview exists keeps that
 * race out of the assertions, without a sleep that would rot.
 */
async function openTestDoc(page: Page) {
  const testFile = page.locator('.explorer-folders-view').getByText('test-doc.md');
  await expect(testFile).toBeVisible({ timeout: 10_000 });
  await expect(async () => {
    await testFile.click();
    await expect(page.locator('iframe.webview')).not.toHaveCount(0, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

test.describe('DocBlocks webview theme parity', () => {
  test.beforeEach(async ({ page }) => {
    // Must be installed before any webview frame exists, so the recorder sees
    // the editor shell's very first painted `data-theme`.
    await page.addInitScript(THEME_LOG_INIT);
    await page.goto('/');
    await waitForVSCode(page);
  });

  test('paints light on a light VS Code theme without ever flashing dark', async ({ page }) => {
    // Pin the theme explicitly rather than trusting the host default, and do it
    // before the webview exists so the editor's first frame is the one tested.
    await selectColorTheme(page, 'Light Modern');
    await openTestDoc(page);

    const frame = await findEditorFrame(page);
    await expect(frame.locator('.db-shell[data-theme]')).toHaveAttribute('data-theme', 'light', {
      timeout: 15_000,
    });

    const log = await readSettledThemeLog(frame, 1);
    expect(
      log,
      `The webview shell painted these themes in order: ${JSON.stringify(log)}. ` +
        `A leading "dark" means it mounted on a hardcoded default and flipped once the ` +
        `host's themeChange arrived — the flash this assertion exists to catch.`,
    ).toEqual(['light']);
  });

  test('follows a live theme switch after mount, and the recorder proves it', async ({ page }) => {
    await selectColorTheme(page, 'Light Modern');
    await openTestDoc(page);

    const frame = await findEditorFrame(page);
    const shell = frame.locator('.db-shell[data-theme]');
    await expect(shell).toHaveAttribute('data-theme', 'light', { timeout: 15_000 });

    // The host observes onDidChangeActiveColorTheme and pushes `themeChange`;
    // an already-mounted editor must honour it.
    await selectColorTheme(page, 'Dark Modern');
    await expect(shell).toHaveAttribute('data-theme', 'dark', { timeout: 15_000 });

    await selectColorTheme(page, 'Light Modern');
    await expect(shell).toHaveAttribute('data-theme', 'light', { timeout: 15_000 });

    // Two jobs: live `themeChange` reaches the shell, and — because these flips
    // are recorded — the sibling test's flash detector is demonstrably able to
    // see a theme it should not have painted.
    const log = await readSettledThemeLog(frame, 3);
    expect(
      log,
      `Expected the recorder to capture both switches. Saw: ${JSON.stringify(log)}`,
    ).toEqual(['light', 'dark', 'light']);
  });
});
