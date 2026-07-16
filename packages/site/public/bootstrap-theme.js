(() => {
  try {
    const preference = globalThis.localStorage.getItem('docblocks:themePreference');
    if (preference === 'light' || preference === 'dark') {
      globalThis.document.documentElement.dataset.dbTheme = preference;
    }
  } catch {
    // Storage can be unavailable in hardened browsing contexts. The CSS
    // media-query fallback still resolves the system appearance.
  }
})();
