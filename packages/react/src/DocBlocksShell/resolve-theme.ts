/**
 * Theme resolution for the shell.
 *
 * Three inputs decide what `data-theme` the shell stamps, and they are not
 * equal partners:
 *
 *   1. `preference` — what the user picked in Settings. It is *their* app;
 *      an explicit choice here outranks whatever the host asked for.
 *   2. `hostTheme` — the `theme` prop a host passes to `<DocBlocksShell>`.
 *      A default, not a command: it decides the look before the user has an
 *      opinion, and whenever the user's opinion is "System default".
 *   3. `osTheme` — the OS/browser `prefers-color-scheme`, the last resort.
 *
 * Both `preference` and `hostTheme` use `'auto'` to mean "I have no opinion,
 * ask the next one down", which is what makes the chain collapse cleanly to
 * the OS when nobody has an opinion.
 *
 * This exists as a pure function because the shell itself is not
 * unit-renderable (lazy editor chunk, workspace bootstrap, IndexedDB), and
 * the precedence order is the part worth pinning.
 */

import type { ThemePreference } from '../preferences/theme.js';

export interface ResolveThemeInput {
  /** The user's Settings choice. Wins unless it is 'auto'. */
  preference: ThemePreference;
  /** The host's `theme` prop. Consulted when the preference is 'auto'. */
  hostTheme?: ThemePreference;
  /** `prefers-color-scheme`, used when nobody else has an opinion. */
  osTheme: 'light' | 'dark';
}

export function resolveShellTheme({
  preference,
  hostTheme,
  osTheme,
}: ResolveThemeInput): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference;
  if (hostTheme === 'light' || hostTheme === 'dark') return hostTheme;
  return osTheme;
}
