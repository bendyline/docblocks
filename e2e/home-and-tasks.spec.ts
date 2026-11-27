import type { Page } from '@playwright/test';
import { newDocumentGallery } from './helpers/new-document.js';
import { openInitializedSite } from './helpers/site.js';
import { expect, test } from './helpers/test.js';

/**
 * Home, the Tasks page and a tasks folder's board: everything is a Markdown
 * file in a folder, so each check here also looks at the file tree.
 */

function places(page: Page) {
  return page.getByRole('navigation', { name: 'Home and lists' });
}

function treeRow(page: Page, path: string) {
  return page.locator(`.db-tree-row[data-path="${path}"], .db-tree-row[data-path="/${path}"]`);
}

function quickJot(page: Page) {
  return page.getByRole('region', { name: 'Quick Jot' });
}

const JOT_BUTTONS = {
  task: 'New task from jot',
  journal: 'Add jot to journal',
  document: 'New document from jot',
} as const;

/** Jot into the left pane and wait for the box to clear, which means the file was written. */
async function jot(page: Page, text: string, as: keyof typeof JOT_BUTTONS = 'task') {
  const field = quickJot(page).getByLabel('Jot something down');
  await field.fill(text);
  await quickJot(page).getByRole('button', { name: JOT_BUTTONS[as], exact: true }).click();
  await expect(field).toHaveValue('');
}

/**
 * Set up a kind of folder from Home's Get started cards; Quick Jot then offers it.
 * Its make buttons show only once the box has something in it, so this jots a
 * probe to see the offer, then clears it.
 */
async function setUpFromHome(page: Page, kind: 'tasks' | 'journal') {
  await places(page).getByRole('button', { name: 'Home' }).click();
  const home = page.getByRole('region', { name: 'Home' });
  await home
    .getByRole('button', { name: kind === 'tasks' ? 'Add a tasks folder' : 'Start a journal' })
    .click();
  const field = quickJot(page).getByLabel('Jot something down');
  await field.fill('Probe');
  await expect(
    quickJot(page).getByRole('button', {
      name: JOT_BUTTONS[kind === 'tasks' ? 'task' : 'journal'],
    }),
  ).toBeVisible({ timeout: 15_000 });
  await field.fill('');
}

test('Quick Jot adds tasks once Home sets up a tasks folder, and Home lists what is due', async ({
  page,
}) => {
  await openInitializedSite(page);
  await places(page).getByRole('button', { name: 'Home' }).click();

  const home = page.getByRole('region', { name: 'Home' });
  await expect(home.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/:home$/);
  // Home no longer has a capture row of its own: Quick Jot in the left pane is it.
  await expect(page.getByLabel('Add a task or jot something down')).toHaveCount(0);
  // Until a tasks folder exists, a jot can become a document but not a task.
  await quickJot(page).getByLabel('Jot something down').fill('Probe');
  await expect(quickJot(page).getByRole('button', { name: JOT_BUTTONS.document })).toBeVisible();
  await expect(quickJot(page).getByRole('button', { name: JOT_BUTTONS.task })).toHaveCount(0);
  await quickJot(page).getByLabel('Jot something down').fill('');

  await setUpFromHome(page, 'tasks');
  await jot(page, 'Pay water bill today');
  await jot(page, 'Call Priya tomorrow');
  await places(page).getByRole('button', { name: 'Home' }).click();

  const today = home.getByRole('region', { name: 'Today' });
  await expect(today.getByRole('button', { name: 'Pay water bill' })).toBeVisible();
  await expect(today.locator('.db-task-due')).toHaveText('Today');
  await expect(home.getByRole('region', { name: 'This week' })).toContainText('Call Priya');
  await expect(places(page).getByRole('button', { name: /^Tasks/ })).toBeVisible();

  // The tasks are files in the folder Home set up.
  await treeRow(page, 'Tasks').click();
  await treeRow(page, 'Tasks/Active').click();
  await expect(treeRow(page, 'Tasks/Active/Pay water bill.md')).toBeVisible();

  // Finishing a task moves its file to Done.
  await places(page).getByRole('button', { name: 'Home' }).click();
  await today.getByRole('checkbox', { name: 'Mark “Pay water bill” done' }).click();
  await expect(today).toContainText('Nothing is due today.');
  await treeRow(page, 'Tasks/Done').click();
  await expect(treeRow(page, 'Tasks/Done/Pay water bill.md')).toBeVisible();
});

test('a tasks folder shows a board whose columns are its folders', async ({ page }) => {
  await openInitializedSite(page);
  await setUpFromHome(page, 'tasks');
  await jot(page, 'Book dentist friday');
  await jot(page, 'Renew passport');

  await treeRow(page, 'Tasks').click();
  const board = page.getByRole('region', { name: 'Tasks, tasks' });
  await expect(board.getByRole('region', { name: 'Active' })).toContainText('Book dentist');
  await expect(page).toHaveURL(/\/:folder\/Tasks$/);

  await board.getByLabel('New list name').fill('Waiting');
  await board.getByRole('button', { name: 'Add list' }).click();
  const waiting = board.getByRole('region', { name: 'Waiting' });
  await expect(waiting).toBeVisible();

  await board.getByRole('combobox', { name: 'Move “Book dentist” to' }).selectOption('Waiting');
  await expect(waiting).toContainText('Book dentist');
  await expect(board.getByRole('region', { name: 'Active' })).not.toContainText('Book dentist');

  // Adding to a column writes the task into that folder.
  await board.getByLabel('Add a task to Waiting').fill('Refund from airline');
  await board.getByLabel('Add a task to Waiting').press('Enter');
  await expect(waiting).toContainText('Refund from airline');

  // The board is a route: a reload comes back to it.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Tasks, tasks' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('region', { name: 'Waiting' })).toContainText('Refund from airline');
});

test('the Tasks page gathers tasks, and Back returns to it from a task', async ({ page }) => {
  await openInitializedSite(page);
  await setUpFromHome(page, 'tasks');
  await jot(page, 'Call Priya tomorrow');
  await places(page)
    .getByRole('button', { name: /^Tasks/ })
    .click();

  const tasks = page.getByRole('region', { name: 'Tasks', exact: true });
  await expect(page).toHaveURL(/\/:tasks$/);
  await tasks.getByRole('radio', { name: /Upcoming/ }).click();
  await tasks.getByRole('button', { name: 'Call Priya' }).click();

  await expect(page.locator('.squisq-status-item').first()).toBeVisible();
  await expect(page).toHaveURL(/Call%20Priya\.md$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/:tasks$/);
  await expect(page.getByRole('region', { name: 'Tasks', exact: true })).toBeVisible();
});

test('the journal and the Unfiled drawer take what Quick Jot captures', async ({ page }) => {
  await openInitializedSite(page);
  await setUpFromHome(page, 'journal');
  await jot(page, 'Coffee with Sam', 'journal');
  // A new document from a jot is kept in the Unfiled drawer and opened.
  await jot(page, 'Acme pricing ideas', 'document');
  await expect(page).toHaveURL(/Unfiled(%2F|\/)Acme%20pricing%20ideas\.md$/);

  await places(page).getByRole('button', { name: 'Journal' }).click();
  const journal = page.getByRole('region', { name: 'Journal, journal' });
  await expect(journal.getByRole('button', { name: "Open today's entry" })).toBeVisible();
  await expect(journal.locator('.db-journal-entry')).toHaveCount(1);

  await places(page)
    .getByRole('button', { name: /^Unfiled/ })
    .click();
  const unfiled = page.getByRole('region', { name: 'Unfiled, waiting to be filed' });
  await expect(
    unfiled.getByRole('button', { name: 'Acme pricing ideas', exact: true }),
  ).toBeVisible();
  await unfiled.getByRole('button', { name: 'Make it a task' }).click();
  await expect(unfiled).toContainText('Nothing is waiting.');
  await places(page)
    .getByRole('button', { name: /^Tasks/ })
    .click();
  await page.getByRole('radio', { name: /All open/ }).click();
  await expect(page.getByRole('region', { name: 'Tasks', exact: true })).toContainText(
    'Acme pricing ideas',
  );
});

test('the details row edits a task in place and finishes it', async ({ page }) => {
  await openInitializedSite(page);
  await setUpFromHome(page, 'tasks');
  await jot(page, 'Water the plants today');
  await places(page).getByRole('button', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Water the plants' }).first().click();
  await expect(page.locator('.squisq-status-item').first()).toBeVisible();

  const details = page.getByRole('form', { name: 'Document details' });
  await expect(details.getByLabel('Due date')).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  await details.getByLabel('Category').fill('Home');
  await details.getByLabel('Category').press('Enter');
  await details.getByLabel('Repeat').selectOption('weekly');
  // With only Active and Done, the Done box is the whole choice: no List field.
  await expect(details.getByLabel('List')).toHaveCount(0);
  // The keys the row edits are not offered again in Squisq's own Properties list.
  await expect(page.getByRole('button', { name: /^Properties \(/ })).toHaveCount(0);

  await details.getByRole('checkbox', { name: 'Done' }).click();
  // A repeating task stays finished in Done, and the next one waits in Active.
  await expect(page).toHaveURL(/Tasks%2FDone%2FWater%20the%20plants\.md$|Tasks\/Done\/Water/);
  await expect(page.getByText('comes round again')).toBeVisible();
  await places(page).getByRole('button', { name: 'Home' }).click();
  const week = page.getByRole('region', { name: 'This week' });
  await expect(week.getByRole('button', { name: 'Water the plants' })).toBeVisible();
  await expect(week).toContainText('Every week');
  await expect(week).toContainText('Home');
});

test('any document can be given a due date from the file list', async ({ page }) => {
  await openInitializedSite(page);
  await treeRow(page, 'Welcome.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add a due date or tags' }).click();
  const details = page.getByRole('form', { name: 'Document details' });
  await expect(details).toBeVisible();
  await details.getByLabel('Due date').fill('2030-01-15');
  await places(page)
    .getByRole('button', { name: /^Tasks/ })
    .click();
  await page.getByRole('radio', { name: /Upcoming/ }).click();
  await expect(page.getByRole('region', { name: 'Tasks', exact: true })).toContainText(
    'Welcome to DocBlocks',
  );
});

test('opens on Home when asked to', async ({ page }) => {
  await openInitializedSite(page);
  await places(page).getByRole('button', { name: 'Home' }).click();
  await page.getByLabel('Show Home when DocBlocks opens').check();
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Home' })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/:home$/);
  await page.getByLabel('Show Home when DocBlocks opens').uncheck();
  await treeRow(page, 'Welcome.md').click();
  await expect(page.locator('.squisq-status-item').first()).toBeVisible();
  await page.goto('/');
  await expect(page.locator('.squisq-status-item').first()).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/Welcome\.md$/);
});

test('the New document gallery starts a new tasks folder', async ({ page }) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  const gallery = newDocumentGallery(page);
  await gallery.getByRole('button', { name: 'Tasks folder', exact: true }).click();
  await expect(gallery).toBeHidden();

  // A folder, set up and opened as a board, rather than a document.
  const board = page.getByRole('region', { name: 'Tasks, tasks' });
  await expect(board.getByRole('region', { name: 'Active' })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/:folder\/Tasks$/);
  await expect(treeRow(page, 'Tasks')).toBeVisible();
  await expect(page.locator('.squisq-status-item')).toHaveCount(0);
});

/** Whether this device's saved digests mention `text` (they are written a moment after a change). */
function savedDigestsMention(page: Page, text: string): Promise<boolean> {
  return page.evaluate(
    (needle) =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open('docblocks-home');
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('digests')) {
            db.close();
            resolve(false);
            return;
          }
          const all = db.transaction('digests', 'readonly').objectStore('digests').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(
              all.result.some((value) => typeof value === 'string' && value.includes(needle)),
            );
          };
          all.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      }),
    text,
  );
}

test('a task in another workspace is ticked off from Home', async ({ page }) => {
  await openInitializedSite(page);
  await setUpFromHome(page, 'tasks');
  await jot(page, 'Renew library card today');
  // Home lists another workspace from its saved digest; wait until it is saved.
  await expect.poll(() => savedDigestsMention(page, 'Renew library card')).toBe(true);

  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page.getByRole('button', { name: 'New Workspace' }).click();
  await page.getByLabel('Workspace name').fill('Side project');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Switch workspace, current: Side project' }),
  ).toBeVisible();
  await places(page).getByRole('button', { name: 'Home' }).click();

  const elsewhere = page.getByRole('region', { name: 'Other workspaces' });
  const tick = elsewhere.getByRole('checkbox', { name: 'Mark “Renew library card” done' });
  await expect(tick).toBeEnabled({ timeout: 15_000 });
  await tick.click();
  // Done in its own workspace: the row leaves Home here, and the file moved there.
  await expect(elsewhere.getByRole('button', { name: 'Renew library card' })).toHaveCount(0);

  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page.getByRole('button', { name: 'My Documents', exact: true }).click();
  await treeRow(page, 'Tasks').click();
  await treeRow(page, 'Tasks/Done').click();
  await expect(treeRow(page, 'Tasks/Done/Renew library card.md')).toBeVisible();
});

test('the Unfiled drawer files a note in a folder of another workspace', async ({ page }) => {
  await openInitializedSite(page);
  // Another workspace, with a folder to file into.
  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page.getByRole('button', { name: 'New Workspace' }).click();
  await page.getByLabel('Workspace name').fill('Side project');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Switch workspace, current: Side project' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New Folder', exact: true }).click();
  await page.locator('.db-new-item-input').fill('Ideas');
  await page.locator('.db-new-item-add').click();
  await expect(treeRow(page, 'Ideas')).toBeVisible();

  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page.getByRole('button', { name: 'My Documents', exact: true }).click();
  // Switching workspaces clears Quick Jot: let it finish before jotting.
  await expect(
    page.getByRole('button', { name: 'Switch workspace, current: My Documents' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My Documents', level: 1 })).toBeVisible();
  await jot(page, 'Acme pricing ideas', 'document');
  await expect(page).toHaveURL(/Unfiled(%2F|\/)Acme%20pricing%20ideas\.md$/);
  await places(page)
    .getByRole('button', { name: /^Unfiled/ })
    .click();
  const unfiled = page.getByRole('region', { name: 'Unfiled, waiting to be filed' });
  await unfiled.getByRole('button', { name: 'File “Acme pricing ideas” in…' }).click();

  // Every workspace is a root, open from the start; the drawer cannot be chosen.
  const picker = page.getByRole('dialog', { name: 'File “Acme pricing ideas” in…' });
  const tree = picker.getByRole('tree', { name: 'Workspaces and folders' });
  await expect(tree.getByRole('treeitem', { name: 'My Documents' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(tree.getByRole('treeitem', { name: 'Unfiled' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(tree.getByRole('treeitem', { name: 'Side project' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  // One click on a folder in another workspace files the note there.
  await tree.getByRole('treeitem', { name: 'Ideas' }).click();
  await expect(picker).toHaveCount(0);
  await expect(unfiled).toContainText('Nothing is waiting.');

  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page.getByRole('button', { name: 'Side project', exact: true }).click();
  await treeRow(page, 'Ideas').click();
  await expect(treeRow(page, 'Ideas/Acme pricing ideas.md')).toBeVisible();
});
