import { DEFAULT_WORKSPACE_ID } from '@bendyline/docblocks/workspace';

/** The starter document created for the app's own empty default workspace. */
export const WELCOME_DOCUMENT_PATH = '/Welcome.md';

/**
 * Names the starter document has shipped under, lowercased. Workspaces seeded
 * before a rename keep their copy, and a lone copy under any of these names is
 * still opened as the welcome document.
 */
const WELCOME_DOCUMENT_NAMES: ReadonlySet<string> = new Set([
  'welcome.md',
  // Seeded as `aboutDocBlocks.md` through 2.7 (`aboutDocblocks.md` before that).
  'aboutdocblocks.md',
]);

/** Whether `path` names the starter document, under its current or a former name. */
export function isWelcomeDocumentPath(path: string): boolean {
  return WELCOME_DOCUMENT_NAMES.has(path.replace(/^\//, '').toLowerCase());
}

/**
 * Whether a workspace is the app's own default — the only place the starter
 * document may be written. On hosts with folder workspaces, the host marks
 * its default (`ElectronWorkspaceInfo.isDefault`); in the browser it is the
 * `default` IndexedDB workspace. A folder the user picked, cloned, or created
 * is never default, so an empty one stays empty.
 */
export function isAppDefaultWorkspace(
  workspaceId: string,
  hostDefaultWorkspaceIds: ReadonlySet<string> | null,
): boolean {
  return hostDefaultWorkspaceIds
    ? hostDefaultWorkspaceIds.has(workspaceId)
    : workspaceId === DEFAULT_WORKSPACE_ID;
}

export interface WelcomeDocumentOptions {
  /** Documents live in browser storage, where the file list offers Back up. */
  readonly browserStorage: boolean;
  /** This is the desktop app, which needs no link to itself. */
  readonly desktopApp: boolean;
}

/**
 * The first document a new user reads, in Write, and the deck they see when
 * they press Slideshow. Written for someone who has never heard of Markdown:
 * it names only controls they can see, and every section is short enough to
 * be a readable slide. Annotations stay attached to headings, so each heading
 * becomes a deliberate presentation block while the source reads as prose.
 */
export function welcomeDocumentContent({
  browserStorage,
  desktopApp,
}: WelcomeDocumentOptions): string {
  return [
    '---',
    'squisq-theme: warm-earth',
    'squisq-cover-slide: false',
    '---',
    '',
    '# Welcome to DocBlocks {[title subtitle="Write once. Share it as a document, a deck, or a video."]}',
    '',
    'This is an ordinary document, so go ahead and change it. Click anywhere and type; DocBlocks saves as you go.',
    '',
    '## Write the way you already do {[list]}',
    '',
    '- Type to add text, and use the toolbar for headings, lists, and bold or italic text.',
    '- Choose **Insert** in the toolbar to add a table, a checklist, a chart, a diagram, or a picture.',
    '- Choose **Source** to see the Markdown text behind this page. Both views edit the same document.',
    '',
    '## One document, many ways to share it {[diagram]}',
    '',
    '```diagram',
    '              +-----------------+',
    '              |  Your document  |',
    '              +--------+--------+',
    '                       |',
    '    +-----------+------+-----+------------+',
    '    |           |            |            |',
    '    v           v            v            v',
    '+-------+  +--------+  +----------+  +---------+',
    '|  PDF  |  |  Word  |  |  Slides  |  |  Video  |',
    '+-------+  +--------+  +----------+  +---------+',
    '```',
    '',
    '## Present it or send it {[content]}',
    '',
    'Each heading starts a new slide, so this document is already a slideshow. Choose **Slideshow** at the top to see it, or **Export** to save it as a PDF, a Word document, a PowerPoint deck, an e-book, a web page, or a video.',
    '',
    '## Your documents stay yours {[factCard]}',
    '',
    // Not "files other apps can open": in the browser they live in browser storage.
    'There is no account to create. Your documents stay on this device, written in plain Markdown that any text editor can read.' +
      // Only browser storage shows Back up in the file list. Elsewhere the
      // documents are files the device itself keeps.
      (browserStorage
        ? ' Choose **Back up** at the bottom of the file list to keep a copy somewhere safe.'
        : ''),
    '',
    '## Make your own {[list]}',
    '',
    '1. Choose **New File** above the file list and give it a name.',
    '2. Write a heading and a few sentences.',
    '3. Choose **Slideshow** to present it, or **Export** to share it.',
    '',
    '## Go further {[list]}',
    '',
    desktopApp
      ? '- Choose **Open Folder** in the workspace menu above the file list to work on Markdown files you already have.'
      : '- [Get the desktop app](https://docblocks.com/desktop/) to work in folders on your computer.',
    '- [Add DocBlocks to VS Code](https://docblocks.com/vscode/) to edit documents beside your code.',
    '- [Read the guides](https://docblocks.com/docs/) for everything else.',
    // End with a newline, as the Write view saves every document. Without it,
    // merely opening the welcome document in Write rewrote the file.
    '',
  ].join('\n');
}

/** The welcome document for the browser, where documents live in browser storage. */
export const WELCOME_DOCUMENT_CONTENT = welcomeDocumentContent({
  browserStorage: true,
  desktopApp: false,
});
