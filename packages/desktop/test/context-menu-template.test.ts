import { expect } from 'chai';
import type {
  EditFlags,
  KeyboardEvent as ElectronKeyboardEvent,
  MenuItemConstructorOptions,
} from 'electron';

import {
  buildEditorContextMenuTemplate,
  MAX_SPELLING_SUGGESTIONS,
  type EditorContextMenuActions,
  type EditorContextMenuParams,
} from '../main/context-menu-template.js';

const editFlags: EditFlags = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: true,
};

function params(overrides: Partial<EditorContextMenuParams> = {}): EditorContextMenuParams {
  return {
    dictionarySuggestions: [],
    editFlags,
    isEditable: true,
    misspelledWord: '',
    selectionText: '',
    spellcheckEnabled: true,
    ...overrides,
  };
}

function itemNames(template: MenuItemConstructorOptions[]): (string | undefined)[] {
  return template.map((item) => item.label ?? item.role ?? item.type);
}

function click(item: MenuItemConstructorOptions | undefined): void {
  if (!item?.click) throw new Error('Expected a clickable menu item.');
  item.click({} as ElectronKeyboardEvent, undefined, undefined);
}

describe('desktop editor context menu template', () => {
  it('offers spelling replacements and a persistent dictionary action', () => {
    const replaced: string[] = [];
    const added: string[] = [];
    const actions: EditorContextMenuActions = {
      replaceMisspelling: (suggestion) => replaced.push(suggestion),
      addToDictionary: (word) => added.push(word),
    };

    const template = buildEditorContextMenuTemplate(
      params({
        dictionarySuggestions: ['particularly', 'particular'],
        misspelledWord: 'partivcuarly',
      }),
      actions,
    );

    expect(itemNames(template).slice(0, 4)).to.deep.equal([
      'particularly',
      'particular',
      'separator',
      'Add to Dictionary',
    ]);
    click(template.find((item) => item.label === 'particularly'));
    click(template.find((item) => item.label === 'Add to Dictionary'));
    expect(replaced).to.deep.equal(['particularly']);
    expect(added).to.deep.equal(['partivcuarly']);
  });

  it('shows a disabled placeholder when the spellchecker has no correction', () => {
    const template = buildEditorContextMenuTemplate(params({ misspelledWord: 'DocBlocks' }), {
      replaceMisspelling() {},
      addToDictionary() {},
    });

    expect(template[0]).to.include({ label: 'No spelling suggestions', enabled: false });
    expect(template.some((item) => item.label === 'Add to Dictionary')).to.equal(true);
  });

  it('deduplicates and bounds operating-system spelling suggestions', () => {
    const dictionarySuggestions = [
      'one',
      'one',
      'wrong',
      ...Array.from({ length: MAX_SPELLING_SUGGESTIONS + 4 }, (_, index) => `word-${index}`),
    ];
    const template = buildEditorContextMenuTemplate(
      params({ dictionarySuggestions, misspelledWord: 'wrong' }),
      { replaceMisspelling() {}, addToDictionary() {} },
    );
    const addIndex = template.findIndex((item) => item.label === 'Add to Dictionary');

    expect(addIndex).to.equal(MAX_SPELLING_SUGGESTIONS + 1);
    expect(template.filter((item) => item.label === 'one')).to.have.length(1);
    expect(template.some((item) => item.label === 'wrong')).to.equal(false);
  });

  it('includes enabled and disabled native editing roles for editable text', () => {
    const template = buildEditorContextMenuTemplate(params(), {
      replaceMisspelling() {},
      addToDictionary() {},
    });

    expect(itemNames(template)).to.deep.equal([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'separator',
      'selectAll',
      'separator',
      'toggleSpellChecker',
    ]);
    expect(template.find((item) => item.role === 'undo')?.enabled).to.equal(true);
    expect(template.find((item) => item.role === 'redo')?.enabled).to.equal(false);
  });

  it('does not compete with renderer menus outside editable or selected text', () => {
    const actions: EditorContextMenuActions = {
      replaceMisspelling() {},
      addToDictionary() {},
    };

    expect(buildEditorContextMenuTemplate(params({ isEditable: false }), actions)).to.deep.equal(
      [],
    );
    expect(
      itemNames(
        buildEditorContextMenuTemplate(
          params({ isEditable: false, selectionText: 'selected' }),
          actions,
        ),
      ),
    ).to.deep.equal(['copy', 'selectAll']);
  });
});
