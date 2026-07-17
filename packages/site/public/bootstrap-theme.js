(() => {
  const accentColors = new Set(['brown', 'green', 'blue', 'purple', 'maroon', 'orange', 'gray']);
  let resolvedTheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

  try {
    const preference = globalThis.localStorage.getItem('docblocks:themePreference');
    if (preference === 'light' || preference === 'dark') {
      resolvedTheme = preference;
    }

    const accentColor = globalThis.localStorage.getItem('docblocks:accentColor');
    if (accentColor && accentColors.has(accentColor)) {
      globalThis.document.documentElement.dataset.dbAccent = accentColor;
    }
  } catch {
    // Storage can be unavailable in hardened browsing contexts. The CSS
    // media-query fallback still resolves the system appearance.
  }

  globalThis.document.documentElement.dataset.dbTheme = resolvedTheme;
})();
