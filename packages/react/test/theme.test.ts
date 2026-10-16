import { expect } from 'chai';
import {
  ACCENT_COLORS,
  loadAccentColor,
  loadThemePreference,
  saveAccentColor,
  saveThemePreference,
} from '../src/preferences/theme.js';

describe('appearance preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to the system theme and rust accent', () => {
    expect(loadThemePreference()).to.equal('auto');
    expect(loadAccentColor()).to.equal('rust');
  });

  it('reads an accent saved under its former name', () => {
    // The default palette was called Brown before it became Rust.
    localStorage.setItem('docblocks:accentColor', 'brown');
    expect(loadAccentColor()).to.equal('rust');
  });

  it('round-trips valid theme and accent preferences', () => {
    saveThemePreference('dark');
    saveAccentColor('purple');

    expect(loadThemePreference()).to.equal('dark');
    expect(loadAccentColor()).to.equal('purple');
  });

  it('exposes all supported accent colors', () => {
    expect(ACCENT_COLORS).to.deep.equal([
      'rust',
      'green',
      'blue',
      'purple',
      'maroon',
      'orange',
      'gray',
    ]);
  });

  it('falls back when stored values are malformed', () => {
    localStorage.setItem('docblocks:themePreference', 'sepia');
    localStorage.setItem('docblocks:accentColor', 'chartreuse');

    expect(loadThemePreference()).to.equal('auto');
    expect(loadAccentColor()).to.equal('rust');

    localStorage.setItem('docblocks:accentColor', 'constructor');
    expect(loadAccentColor()).to.equal('rust');
  });
});
