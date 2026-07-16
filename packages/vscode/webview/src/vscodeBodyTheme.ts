/** The color scheme DocBlocks renders, as carried by the `themeChange` wire message. */
export type VscodeColorScheme = 'light' | 'dark';

/**
 * VS Code stamps its active theme class onto `<body>` before any webview
 * script runs, so the correct theme is readable synchronously at mount. That
 * matters: the host only sends `themeChange` in reply to our `ready` message,
 * which costs a webview -> host -> webview round-trip. Waiting for it means
 * painting a guessed theme first and flipping once it lands.
 *
 * This is the webview half of a two-input theme mapping. The host half maps
 * `vscode.ColorThemeKind` -> the same union in `src/webviewHelper.ts`
 * (`getVscodeTheme`). The two cannot share code — the host half imports
 * `vscode`, which the webview must never load — so they stay separate
 * deliberately and are pinned against drift by
 * `test/webview-theme.test.ts`, which asserts both agree for all four kinds.
 *
 * The high-contrast pairing is the subtle case, and the reason order matters
 * below: for a high-contrast *light* theme VS Code adds BOTH
 * `vscode-high-contrast-light` and `vscode-high-contrast`, the latter
 * explicitly "for backwards compatibility" (see VS Code's own webview host
 * page, `out/vs/workbench/contrib/webview/browser/pre/index.html`). A check
 * that tested `vscode-high-contrast` first would resolve high-contrast light
 * to dark and disagree with the host, which maps `HighContrastLight` to light.
 *
 * @returns the mapped scheme, or `null` when no VS Code theme class is present.
 */
export function resolveVscodeBodyTheme(classNames: Iterable<string>): VscodeColorScheme | null {
  const classes = new Set(classNames);
  // Most specific first: high-contrast light also carries `vscode-high-contrast`.
  if (classes.has('vscode-high-contrast-light')) return 'light';
  if (classes.has('vscode-high-contrast')) return 'dark';
  if (classes.has('vscode-dark')) return 'dark';
  if (classes.has('vscode-light')) return 'light';
  return null;
}

/**
 * Best guess for a context that carries no VS Code theme class at all — which
 * a real VS Code webview never is, since the host page applies the class
 * before scripts run. It is reached only outside VS Code (test harnesses,
 * plain browsers), where `prefers-color-scheme` is exactly the right signal,
 * so consulting it beats any constant in every case where it actually runs.
 *
 * Falls back to 'light' when even that is unavailable: light is the CSS
 * initial `color-scheme`, so it is the least surprising baseline when nothing
 * is known. Notably it is not 'dark' — a dark default is what made a light
 * VS Code flash dark on open in the first place.
 */
function guessThemeWithoutVscodeClass(): VscodeColorScheme {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch {
      // A host without a usable media-query engine just takes the default.
    }
  }
  return 'light';
}

/**
 * Read the theme VS Code has already applied to this webview's `<body>`.
 *
 * Synchronous and message-free, so it can seed state at mount and paint the
 * right theme on the very first frame. Live theme switches still arrive as
 * `themeChange` messages from the host.
 */
export function readVscodeBodyTheme(): VscodeColorScheme {
  const body: { classList?: Iterable<string> } | null =
    typeof document === 'undefined' ? null : document.body;
  const classList = body?.classList;
  return (classList && resolveVscodeBodyTheme(classList)) ?? guessThemeWithoutVscodeClass();
}
