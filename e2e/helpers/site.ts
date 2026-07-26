import { expect, type Page } from '@playwright/test';

// The first request to the Vite dev server can spend materially longer than
// subsequent tests transforming the site and its editor dependencies,
// especially on Windows. Keep startup bounded without making ordinary test
// actions inherit this larger allowance.
const SITE_STARTUP_TIMEOUT_MS = 75_000;
// Polling slice used while waiting for the React shell to replace the SEO
// bootstrap markup. Short enough to react to a dead boot promptly, long enough
// that a healthy-but-slow first transform is not interrupted.
const SHELL_POLL_MS = 2_000;

/** A dev-server failure that stops `/src/main.tsx` from ever executing. */
interface BootFailure {
  detail: string;
}

/**
 * Record the module-graph failures that leave the page stuck on the SEO
 * bootstrap markup with no React shell. Vite's dev server occasionally answers
 * a module request with a 504 (outdated optimized dependency) or drops it
 * mid-flight; the page then renders index.html forever and every subsequent
 * assertion times out with no recorded cause.
 */
function watchBootFailures(page: Page): BootFailure[] {
  const failures: BootFailure[] = [];
  const isModuleRequest = (resourceType: string): boolean =>
    resourceType === 'document' || resourceType === 'script';

  page.on('pageerror', (error) => failures.push({ detail: `page error: ${error.message}` }));
  page.on('requestfailed', (request) => {
    if (!isModuleRequest(request.resourceType())) return;
    failures.push({
      detail: `request failed: ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`,
    });
  });
  page.on('response', (response) => {
    if (response.status() < 400 || !isModuleRequest(response.request().resourceType())) return;
    failures.push({ detail: `HTTP ${response.status()}: ${response.url()}` });
  });

  return failures;
}

/**
 * Wait for React to take over the page, reloading once if the module graph
 * demonstrably failed to load. A silent slow boot keeps the full startup
 * allowance; only a recorded module failure earns the reload, so a genuine
 * regression still fails — now with the underlying error attached.
 */
async function waitForMountedShell(page: Page, failures: BootFailure[]): Promise<void> {
  const shell = page.locator('.db-shell');
  const deadline = Date.now() + SITE_STARTUP_TIMEOUT_MS;
  let reloaded = false;
  let firstAttempt: BootFailure[] = [];

  for (;;) {
    try {
      await expect(shell).toBeVisible({ timeout: SHELL_POLL_MS });
      return;
    } catch (caught: unknown) {
      if (!reloaded && failures.length > 0) {
        reloaded = true;
        firstAttempt = failures.splice(0, failures.length);
        await page.reload({ waitUntil: 'domcontentloaded' });
        continue;
      }
      if (Date.now() >= deadline) {
        const detail = [...firstAttempt, ...failures].map((f) => `  ${f.detail}`).join('\n');
        throw new Error(
          `The site never mounted .db-shell — the page is still showing the SEO bootstrap markup` +
            `${reloaded ? ' after a recovery reload' : ''}.` +
            (detail ? `\nRecorded load failures:\n${detail}` : '\nNo load failure was recorded.') +
            `\n\n${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }
  }
}

/**
 * Open a fresh site context and wait for the asynchronous first-run workspace
 * transaction to finish. Shell/toolbars render before IndexedDB creation,
 * welcome-file seeding, hash navigation, and the lazy editor have completed;
 * tests that acted at that earlier point raced the initialization effect.
 */
export async function openInitializedSite(page: Page): Promise<void> {
  const bootFailures = watchBootFailures(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await waitForMountedShell(page, bootFailures);
  await expect(page.locator('.db-explorer-toolbar')).toBeVisible({
    timeout: SITE_STARTUP_TIMEOUT_MS,
  });

  const welcomeRow = page.locator(
    '.db-tree-row[data-path="aboutDocBlocks.md"], .db-tree-row[data-path="/aboutDocBlocks.md"]',
  );
  const startupError = page.locator('.db-save-toast--error');
  await expect(welcomeRow.or(startupError)).toBeVisible({ timeout: SITE_STARTUP_TIMEOUT_MS });
  if (await startupError.isVisible()) {
    throw new Error(`Site workspace initialization failed: ${await startupError.innerText()}`);
  }

  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash), {
      timeout: SITE_STARTUP_TIMEOUT_MS,
    })
    .toMatch(/\/aboutDocBlocks\.md$/i);

  // The status item proves the selected document's lazy Squisq shell has
  // finished mounting. The welcome gateway is intentionally transient and
  // can disappear before this assertion on a warm dev server.
  await expect(page.locator('.squisq-status-item').first()).toBeVisible({
    timeout: SITE_STARTUP_TIMEOUT_MS,
  });
}
