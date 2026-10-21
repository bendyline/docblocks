import type { MenuItemConstructorOptions } from 'electron';
import type { HostPinnedDocument } from '@bendyline/docblocks/host';

export interface TrayMenuActions {
  newDocument(): void;
  openFolder(): void;
  openPinnedDocument(document: HostPinnedDocument): void;
  showWindow(): void;
}

const MAX_PINNED_LABEL_LENGTH = 80;

function documentName(document: HostPinnedDocument): string {
  const base = document.path.slice(document.path.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * The menu label for each pinned document: its name, with the workspace added
 * when two pins share a name. Windows and Linux read `&` as a mnemonic marker,
 * so a literal one is doubled there.
 */
export function pinnedDocumentLabels(
  documents: readonly HostPinnedDocument[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const names = documents.map(documentName);
  return documents.map((document, index) => {
    const name = names[index];
    const shared = names.some((other, otherIndex) => otherIndex !== index && other === name);
    const label = shared ? `${name} — ${document.workspaceName}` : name;
    // The tray truncates for us on most platforms, but a hard cap keeps the
    // menu from being dominated by a single pathological title.
    const bounded =
      label.length > MAX_PINNED_LABEL_LENGTH
        ? `${label.slice(0, MAX_PINNED_LABEL_LENGTH - 1)}…`
        : label;
    return platform === 'darwin' ? bounded : bounded.replaceAll('&', '&&');
  });
}

export function buildTrayMenuTemplate(
  pinnedDocuments: readonly HostPinnedDocument[],
  actions: TrayMenuActions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const labels = pinnedDocumentLabels(pinnedDocuments, platform);
  const pinnedItems: MenuItemConstructorOptions[] = pinnedDocuments.map((document, index) => ({
    label: labels[index],
    toolTip: `${document.workspaceName}/${document.path}`,
    click: () => actions.openPinnedDocument(document),
  }));

  return [
    { label: 'New Document', click: () => actions.newDocument() },
    { label: 'Open Folder...', click: () => actions.openFolder() },
    ...(pinnedItems.length > 0
      ? ([
          { type: 'separator' },
          { label: 'Pinned', enabled: false },
          ...pinnedItems,
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { type: 'separator' },
    { label: 'Show DocBlocks', click: () => actions.showWindow() },
    // An explicit label: the role's default reads app.name, which an
    // unpackaged run takes from package.json ("docblocks-desktop").
    { label: 'Quit DocBlocks', role: 'quit' },
  ];
}
