import { expect } from 'chai';
import { classifyFormFactor, type DbLayoutMode } from '../src/layout/form-factor.js';
import { useFormFactorAttributes } from '../src/layout/useFormFactorAttributes.js';
import { renderHook } from './helpers/renderHook.js';

describe('useFormFactorAttributes', () => {
  it('only publishes changed traits during resize and removes them on unmount', async () => {
    const shell = document.createElement('div');
    document.body.append(shell);
    const ref = { current: shell };
    const mutations: string[] = [];
    const observer = new MutationObserver((records) => {
      mutations.push(...records.map((record) => record.attributeName ?? ''));
    });
    for (const element of [shell, document.documentElement]) {
      observer.observe(element, { attributes: true });
    }
    const hook = await renderHook(
      ({ width, layout, drawer }: { width: number; layout: DbLayoutMode; drawer: boolean }) =>
        useFormFactorAttributes(
          ref,
          classifyFormFactor({
            width,
            height: 700,
            pointer: 'fine',
            hover: 'hover',
            installed: false,
          }),
          layout,
          drawer,
        ),
      { width: 1200, layout: 'split-pane', drawer: false },
    );
    const readMutations = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return mutations.splice(0);
    };
    try {
      await readMutations();
      await hook.rerender({ width: 1201, layout: 'split-pane', drawer: false });
      expect(
        await readMutations(),
        'same classification must not wake attribute observers',
      ).to.deep.equal([]);

      await hook.rerender({ width: 600, layout: 'single-pane', drawer: true });
      await readMutations();
      expect(shell.getAttribute('data-db-drawer')).to.equal('open');
      await hook.rerender({ width: 600, layout: 'single-pane', drawer: false });
      expect(await readMutations()).to.deep.equal(['data-db-drawer', 'data-db-drawer']);
      await hook.rerender({ width: 1200, layout: 'split-pane', drawer: false });
      expect(shell.hasAttribute('data-db-drawer')).to.equal(false);
    } finally {
      await hook.unmount();
      observer.disconnect();
      shell.remove();
    }
    expect(shell.hasAttribute('data-db-layout')).to.equal(false);
    expect(document.documentElement.hasAttribute('data-db-layout')).to.equal(false);
  });
});
