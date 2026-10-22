import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import {
  listDisplayCaptureSources,
  pickDisplayCaptureSource,
} from '../main/display-capture-picker.js';

const sources = [
  { id: 'screen:1:0', name: 'Screen 1', display_id: '1' },
  { id: 'screen:2:0', name: 'Screen 2', display_id: '2' },
  { id: 'window:3:0', name: 'Editor & notes', display_id: '' },
];

function fixture() {
  const contents = new EventEmitter();
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  });
  let items: MenuItemConstructorOptions[] = [];
  let closed = 0;
  let dismiss: () => void = () => {};
  const result = pickDisplayCaptureSource(
    window as unknown as BrowserWindow,
    sources,
    (template) => {
      items = template;
      return {
        popup: (options: { callback: () => void }) => {
          dismiss = options.callback;
        },
        closePopup: () => {
          closed++;
          dismiss();
        },
      } as unknown as Menu;
    },
  );
  const choose = (group: string, index: number) => {
    const submenu = items.find((item) => item.label === group)
      ?.submenu as MenuItemConstructorOptions[];
    (submenu[index]!.click as () => void)();
  };
  return {
    result,
    choose,
    dismiss: () => dismiss(),
    window,
    contents,
    closed: () => closed,
    items,
  };
}

describe('desktop display capture picker', () => {
  it('lists screens, then windows, without overlapping lookups', async () => {
    const calls: string[][] = [];
    let inFlight = 0;
    let overlapped = false;
    const listed = await listDisplayCaptureSources(async (options) => {
      calls.push([...options.types]);
      inFlight++;
      overlapped ||= inFlight > 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return sources.filter((source) => source.id.startsWith(`${options.types[0]!}:`));
    });
    // Overlapping lookups race on X11 and drop every screen.
    expect(overlapped).to.equal(false);
    expect(calls).to.deep.equal([['screen'], ['window']]);
    expect(listed).to.deep.equal(sources);
  });

  it('offers every screen and app window, and returns only the explicit selection', async () => {
    const picker = fixture();
    picker.choose('Screens', 1);
    expect(await picker.result).to.equal(sources[1]);
    expect(picker.closed()).to.equal(1);
    expect(picker.contents.listenerCount('did-start-navigation')).to.equal(0);
    const appPicker = fixture();
    appPicker.choose('Application windows', 0);
    expect(await appPicker.result).to.equal(sources[2]);
  });

  it('cancels on dismissal, navigation, renderer loss and window close', async () => {
    for (const event of ['dismiss', 'did-start-navigation', 'destroyed', 'closed']) {
      const picker = fixture();
      if (event === 'dismiss') picker.dismiss();
      else if (event === 'closed') picker.window.emit(event);
      else picker.contents.emit(event);
      expect(await picker.result).to.equal(null);
      picker.choose('Screens', 0);
      expect(await picker.result).to.equal(null);
      expect(picker.closed()).to.equal(1);
      expect(picker.contents.eventNames()).to.deep.equal([]);
    }
  });
});
