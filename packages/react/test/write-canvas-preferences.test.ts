import { expect } from 'chai';
import {
  DEFAULT_WRITE_CANVAS_PREFERENCES,
  loadWriteCanvasPreferences,
  resolveWriteCanvasFonts,
  saveWriteCanvasPreferences,
  WRITE_CANVAS_FONT_SCHEMES,
} from '../src/preferences/write-canvas.js';

describe('Write canvas preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses the Squisq canvas defaults when no preference is stored', () => {
    expect(loadWriteCanvasPreferences()).to.deep.equal(DEFAULT_WRITE_CANVAS_PREFERENCES);
  });

  it('defaults the font scheme to inherit-from-theme', () => {
    expect(DEFAULT_WRITE_CANVAS_PREFERENCES.fontScheme).to.equal('theme');
  });

  it('round-trips text size, line spacing and font scheme', () => {
    saveWriteCanvasPreferences({ textSize: 20, lineSpacing: 1, fontScheme: 'pt-serif' });

    expect(loadWriteCanvasPreferences()).to.deep.equal({
      textSize: 20,
      lineSpacing: 1,
      fontScheme: 'pt-serif',
    });
  });

  it('falls back per field when stored values are malformed or outside the sliders', () => {
    localStorage.setItem(
      'docblocks:writeCanvasSettings',
      JSON.stringify({ textSize: 100, lineSpacing: 1.8, fontScheme: 'nope' }),
    );

    expect(loadWriteCanvasPreferences()).to.deep.equal({
      textSize: 16,
      lineSpacing: 1.8,
      fontScheme: 'theme',
    });

    localStorage.setItem('docblocks:writeCanvasSettings', '{bad json');
    expect(loadWriteCanvasPreferences()).to.deep.equal(DEFAULT_WRITE_CANVAS_PREFERENCES);
  });

  it('defaults the font scheme when older preferences predate it', () => {
    localStorage.setItem(
      'docblocks:writeCanvasSettings',
      JSON.stringify({ textSize: 18, lineSpacing: 1.5 }),
    );

    expect(loadWriteCanvasPreferences()).to.deep.equal({
      textSize: 18,
      lineSpacing: 1.5,
      fontScheme: 'theme',
    });
  });

  it('resolves the theme scheme to no fonts and named schemes to families', () => {
    expect(resolveWriteCanvasFonts('theme')).to.deep.equal({});

    const ptSerif = resolveWriteCanvasFonts('pt-serif');
    expect(ptSerif.headerFont).to.contain('PT Serif');
    expect(ptSerif.bodyFont).to.contain('PT Serif');

    const pairing = resolveWriteCanvasFonts('playfair-pt-serif');
    expect(pairing.headerFont).to.contain('Playfair Display');
    expect(pairing.bodyFont).to.contain('PT Serif');
  });

  it('gives every non-theme scheme both a header and body family', () => {
    for (const scheme of WRITE_CANVAS_FONT_SCHEMES) {
      if (scheme.id === 'theme') {
        expect(scheme.headerFont).to.equal(undefined);
        expect(scheme.bodyFont).to.equal(undefined);
      } else {
        expect(scheme.headerFont, `${scheme.id} headerFont`)
          .to.be.a('string')
          .with.length.greaterThan(0);
        expect(scheme.bodyFont, `${scheme.id} bodyFont`)
          .to.be.a('string')
          .with.length.greaterThan(0);
      }
    }
  });
});
