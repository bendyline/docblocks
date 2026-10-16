(() => {
  const accentColors = new Set(['rust', 'green', 'blue', 'purple', 'maroon', 'orange', 'gray']);
  // The default palette was called Brown before it became Rust.
  const legacyAccentColors = new Map([['brown', 'rust']]);
  let resolvedTheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

  try {
    const preference = globalThis.localStorage.getItem('docblocks:themePreference');
    if (preference === 'light' || preference === 'dark') {
      resolvedTheme = preference;
    }

    const storedAccent = globalThis.localStorage.getItem('docblocks:accentColor');
    const accentColor = legacyAccentColors.get(storedAccent) ?? storedAccent;
    if (accentColor && accentColors.has(accentColor)) {
      globalThis.document.documentElement.dataset.dbAccent = accentColor;
    }
  } catch {
    // Storage can be unavailable in hardened browsing contexts. The CSS
    // media-query fallback still resolves the system appearance.
  }

  globalThis.document.documentElement.dataset.dbTheme = resolvedTheme;
})();
