import { expect } from 'chai';
import {
  PORTRAIT_FORM_FACTOR_QUERY,
  previewViewportPresetForOrientation,
  useResponsivePreviewViewportPreset,
} from '../src/editor.js';
import { act, renderHook } from './helpers/renderHook.js';

describe('responsive preview viewport', () => {
  it('maps the host surface orientation to the matching canvas preset', () => {
    expect(previewViewportPresetForOrientation(true)).to.equal('portrait');
    expect(previewViewportPresetForOrientation(false)).to.equal('landscape');
  });

  it('tracks live portrait-orientation media query changes', async () => {
    const originalMatchMedia = globalThis.matchMedia;
    const listeners = new Set<() => void>();
    let isPortrait = true;
    globalThis.matchMedia = ((query: string) =>
      ({
        get matches() {
          return query === PORTRAIT_FORM_FACTOR_QUERY && isPortrait;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }) satisfies MediaQueryList) as typeof globalThis.matchMedia;

    try {
      const hook = await renderHook(() => useResponsivePreviewViewportPreset(), undefined);
      expect(hook.result.current).to.equal('portrait');

      await act(async () => {
        isPortrait = false;
        for (const listener of listeners) listener();
      });
      expect(hook.result.current).to.equal('landscape');

      await hook.unmount();
      expect(listeners.size).to.equal(0);
    } finally {
      globalThis.matchMedia = originalMatchMedia;
    }
  });
});
