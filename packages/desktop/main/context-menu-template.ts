import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

export const MAX_SPELLING_SUGGESTIONS = 8;

export type EditorContextMenuParams = Pick<
  ContextMenuParams,
  | 'dictionarySuggestions'
  | 'editFlags'
  | 'isEditable'
  | 'misspelledWord'
  | 'selectionText'
  | 'spellcheckEnabled'
>;

export interface EditorContextMenuActions {
  addToDictionary(word: string): void;
  replaceMisspelling(suggestion: string): void;
}

function spellingItems(
  params: EditorContextMenuParams,
  actions: EditorContextMenuActions,
): MenuItemConstructorOptions[] {
  if (!params.spellcheckEnabled || params.misspelledWord.length === 0) return [];

  // Chromium normally returns only a handful of candidates. Keep the native
  // menu bounded and remove duplicates in case an OS spellchecker is noisier.
  const suggestions = [...new Set(params.dictionarySuggestions)]
    .filter((suggestion) => suggestion.length > 0 && suggestion !== params.misspelledWord)
    .slice(0, MAX_SPELLING_SUGGESTIONS);
  const items: MenuItemConstructorOptions[] = suggestions.map((suggestion) => ({
    label: suggestion,
    click: () => actions.replaceMisspelling(suggestion),
  }));

  if (items.length === 0) {
    items.push({ label: 'No spelling suggestions', enabled: false });
  }
  items.push(
    { type: 'separator' },
    {
      label: 'Add to Dictionary',
      click: () => actions.addToDictionary(params.misspelledWord),
    },
  );
  return items;
}

function editableItems(params: EditorContextMenuParams): MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    return params.selectionText.length > 0
      ? [
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll },
        ]
      : [];
  }

  return [
    { role: 'undo', enabled: params.editFlags.canUndo },
    { role: 'redo', enabled: params.editFlags.canRedo },
    { type: 'separator' },
    { role: 'cut', enabled: params.editFlags.canCut },
    { role: 'copy', enabled: params.editFlags.canCopy },
    { role: 'paste', enabled: params.editFlags.canPaste },
    { role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste },
    { role: 'delete', enabled: params.editFlags.canDelete },
    { type: 'separator' },
    { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    { type: 'separator' },
    { role: 'toggleSpellChecker' },
  ];
}

/**
 * Build the native text-editing menu without importing Electron at runtime.
 * Keeping this policy pure makes the menu behavior independently testable.
 */
export function buildEditorContextMenuTemplate(
  params: EditorContextMenuParams,
  actions: EditorContextMenuActions,
): MenuItemConstructorOptions[] {
  const spelling = spellingItems(params, actions);
  const editing = editableItems(params);
  if (spelling.length === 0) return editing;
  if (editing.length === 0) return spelling;
  return [...spelling, { type: 'separator' }, ...editing];
}
