import { expect } from 'chai';
import {
  DEFAULT_WRITE_CANVAS_PREFERENCES,
  loadWriteCanvasPreferences,
  saveWriteCanvasPreferences,
} from '../src/preferences/write-canvas.js';

describe('Write canvas preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses the Squisq canvas defaults when no preference is stored', () => {
    expect(loadWriteCanvasPreferences()).to.deep.equal(DEFAULT_WRITE_CANVAS_PREFERENCES);
  });

  it('round-trips text size and line spacing', () => {
    saveWriteCanvasPreferences({ textSize: 20, lineSpacing: 1 });

    expect(loadWriteCanvasPreferences()).to.deep.equal({ textSize: 20, lineSpacing: 1 });
  });

  it('falls back per field when stored values are malformed or outside the sliders', () => {
    localStorage.setItem(
      'docblocks:writeCanvasSettings',
      JSON.stringify({ textSize: 100, lineSpacing: 1.8 }),
    );

    expect(loadWriteCanvasPreferences()).to.deep.equal({ textSize: 16, lineSpacing: 1.8 });

    localStorage.setItem('docblocks:writeCanvasSettings', '{bad json');
    expect(loadWriteCanvasPreferences()).to.deep.equal(DEFAULT_WRITE_CANVAS_PREFERENCES);
  });
});
