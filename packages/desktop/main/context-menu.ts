import { Menu, type BrowserWindow, type ContextMenuParams } from 'electron';

import { buildEditorContextMenuTemplate } from './context-menu-template.js';

/** Attach the native spelling and text-editing menu for one renderer window. */
export function attachEditorContextMenu(win: BrowserWindow): void {
  const contents = win.webContents;
  contents.on('context-menu', (_event, params: ContextMenuParams) => {
    const template = buildEditorContextMenuTemplate(params, {
      replaceMisspelling: (suggestion) => contents.replaceMisspelling(suggestion),
      addToDictionary: (word) => {
        contents.session.addWordToSpellCheckerDictionary(word);
      },
    });
    if (template.length === 0) return;

    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: win,
      x: params.x,
      y: params.y,
      sourceType: params.menuSourceType,
      ...(params.frame ? { frame: params.frame } : {}),
    });
  });
}
