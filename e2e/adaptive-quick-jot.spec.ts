import { installFakeSpeechHost } from './helpers/fake-speech-host.js';
import { expect, test } from './helpers/test.js';
import { touchDrag } from './helpers/touch.js';

/**
 * Quick Jot in the phone drawer: touch-sized, no wider than the drawer, a
 * drag inside its text leaves the drawer open, and dictation (offered where
 * the host can transcribe) leads to Settings until a model is downloaded.
 */
test.describe('Quick Jot on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('fits the drawer at touch size and keeps it open while you work in it', async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await installFakeSpeechHost(page);
    await page.goto('/');
    const tour = page.getByRole('button', { name: 'Tour the welcome document' });
    const startWriting = page.locator('.db-welcome-gateway-cta');
    await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
    await ((await tour.count()) > 0 ? tour : startWriting).click();
    const shell = page.locator('.db-shell');
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed', { timeout: 30_000 });
    await expect(shell).toHaveAttribute('data-db-pointer', 'coarse');

    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
    const jot = page.getByRole('region', { name: 'Quick Jot' });
    await expect(jot).toBeVisible();
    const mic = jot.getByRole('button', { name: /^Dictate/ });
    await expect(mic).toBeVisible();

    const field = jot.getByLabel('Jot something down');
    const measures = await jot.evaluate((section) => {
      const textarea = section.querySelector('textarea')!;
      const undersized = [...section.querySelectorAll<HTMLElement>('.db-quick-jot-btn')]
        .map((button) => {
          const box = button.getBoundingClientRect();
          const inset = Number.parseFloat(
            getComputedStyle(button, '::after').insetBlockStart || '0',
          );
          return { height: box.height - inset * 2, width: box.width - inset * 2 };
        })
        .filter((size) => size.height < 44 || size.width < 24);
      return {
        undersized,
        fontSize: Number.parseFloat(getComputedStyle(textarea).fontSize),
        overflow: section.scrollWidth - section.clientWidth,
      };
    });
    expect(measures.undersized).toEqual([]);
    // Below 16px, focusing the field makes iOS Safari zoom the page.
    expect(measures.fontSize).toBeGreaterThanOrEqual(16);
    expect(measures.overflow).toBeLessThanOrEqual(0);

    // iOS's keyboard covers the bottom of the drawer, where the jot sits, without
    // resizing the page; the inset useKeyboardInset publishes lifts it clear.
    const keyboard = 300;
    const lifted = await jot.evaluate((section, inset) => {
      const root = document.documentElement;
      root.style.setProperty('--db-keyboard-inset', `${inset}px`);
      const bottom = section.getBoundingClientRect().bottom;
      root.style.removeProperty('--db-keyboard-inset');
      return { bottom, keyboardTop: window.innerHeight - inset };
    }, keyboard);
    expect(lifted.bottom).toBeLessThanOrEqual(lifted.keyboardTop);

    if (browserName === 'chromium') {
      await field.fill('Selecting words in here is not a swipe');
      const box = await field.boundingBox();
      if (!box) throw new Error('Quick Jot text not laid out');
      const y = box.y + box.height / 2;
      await touchDrag(page, { x: box.x + box.width * 0.8, y }, { x: box.x + 8, y });
      await expect(shell).toHaveAttribute('data-db-drawer', 'open');
    }

    // Without a dictation model, the microphone leads to where one is downloaded.
    await mic.click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Settings section' })).toHaveValue(
      'dictation',
    );
  });
});
