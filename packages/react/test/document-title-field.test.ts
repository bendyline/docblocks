import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DocumentTitleField,
  type DocumentTitleFieldProps,
} from '../src/DocBlocksShell/DocumentTitleField.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

/** Write through the prototype setter so React's value tracker sees a change. */
function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(element: HTMLInputElement, key: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('DocumentTitleField', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(props: Partial<DocumentTitleFieldProps> = {}): Promise<HTMLInputElement> {
    await act(async () => {
      root.render(
        createElement(DocumentTitleField, {
          fileName: 'notes.md',
          onRename: async () => undefined,
          ...props,
        }),
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename document"]');
    if (!input) throw new Error('The title field did not render');
    return input;
  }

  it('shows a Markdown document without its extension and other files in full', async () => {
    expect((await render({ fileName: 'notes.md' })).value).to.equal('notes');
    expect((await render({ fileName: 'report.docx' })).value).to.equal('report.docx');
  });

  it('commits once on Enter with the extension restored, despite the trailing blur', async () => {
    const renames: string[] = [];
    const input = await render({
      onRename: async (name) => {
        renames.push(name);
      },
    });

    await act(async () => input.focus());
    await act(async () => typeInto(input, 'Quarterly plan'));
    // Enter blurs the field itself; that blur must not commit again.
    await act(async () => press(input, 'Enter'));
    await act(async () => input.blur());

    expect(renames).to.deep.equal(['Quarterly plan.md']);
  });

  it('commits when focus leaves the field', async () => {
    const renames: string[] = [];
    const input = await render({
      fileName: 'report.docx',
      onRename: async (name) => {
        renames.push(name);
      },
    });

    await act(async () => input.focus());
    await act(async () => typeInto(input, 'summary'));
    await act(async () => input.blur());

    // A typed name without an extension keeps the file's own.
    expect(renames).to.deep.equal(['summary.docx']);
  });

  it('puts the name back on Escape without renaming', async () => {
    let renamed = false;
    const input = await render({
      onRename: async () => {
        renamed = true;
      },
    });

    await act(async () => input.focus());
    await act(async () => typeInto(input, 'Something else'));
    await act(async () => press(input, 'Escape'));
    await act(async () => input.blur());

    expect(renamed).to.equal(false);
    expect(input.value).to.equal('notes');
  });

  it('does not rename for an empty or unchanged name', async () => {
    let renames = 0;
    const input = await render({
      onRename: async () => {
        renames += 1;
      },
    });

    await act(async () => input.focus());
    await act(async () => typeInto(input, '   '));
    await act(async () => input.blur());
    expect(input.value).to.equal('notes');

    await act(async () => input.focus());
    await act(async () => typeInto(input, 'notes'));
    await act(async () => input.blur());

    expect(renames).to.equal(0);
  });

  it('shows the current name again after a rename the host rejected', async () => {
    const input = await render({
      // The host reports the failure itself and leaves the file as it was.
      onRename: async () => undefined,
    });

    await act(async () => input.focus());
    await act(async () => typeInto(input, 'taken'));
    await act(async () => press(input, 'Enter'));

    expect(input.value).to.equal('notes');
  });

  it('selects the title but not the extension on keyboard focus', async () => {
    const input = await render({ fileName: 'report.docx' });

    await act(async () => input.focus());

    expect([input.selectionStart, input.selectionEnd]).to.deep.equal([0, 'report'.length]);
  });

  it('does not rename a read-only name', async () => {
    let renamed = false;
    const input = await render({
      readOnly: true,
      onRename: async () => {
        renamed = true;
      },
    });

    expect(input.readOnly).to.equal(true);
    await act(async () => input.focus());
    await act(async () => press(input, 'Enter'));

    expect(renamed).to.equal(false);
  });
});
