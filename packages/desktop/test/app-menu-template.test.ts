import { expect } from 'chai';
import type { MenuItemConstructorOptions } from 'electron';

import { buildMacAppMenuTemplate } from '../main/app-menu-template.js';

function items(showUpdateCheck: boolean, checkForUpdates = () => undefined) {
  const submenu = buildMacAppMenuTemplate({ showUpdateCheck, checkForUpdates }).submenu;
  expect(Array.isArray(submenu)).to.equal(true);
  return submenu as MenuItemConstructorOptions[];
}

describe('macOS application menu', () => {
  it('names DocBlocks on every item whose role default would read app.name', () => {
    const byRole = new Map(items(true).map((item) => [item.role, item.label]));
    expect(byRole.get('about')).to.equal('About DocBlocks');
    expect(byRole.get('hide')).to.equal('Hide DocBlocks');
    expect(byRole.get('quit')).to.equal('Quit DocBlocks');
  });

  it('never shows the package name', () => {
    const labels = items(true).map((item) => item.label ?? '');
    expect(labels.join(' ')).not.to.include('docblocks-desktop');
  });

  it('offers Check for Updates only outside store builds', () => {
    const calls: string[] = [];
    const update = items(true, () => calls.push('check')).find(
      (item) => item.label === 'Check for Updates...',
    );
    expect(update).not.to.equal(undefined);
    (update!.click as () => void)();
    expect(calls).to.deep.equal(['check']);

    expect(items(false).some((item) => item.label === 'Check for Updates...')).to.equal(false);
  });
});
