/** Return the canonical built-in theme IDs from the linked Squisq runtime. */
export async function getAvailableThemeIds(): Promise<readonly string[]> {
  const { getAvailableThemes } = await import('@bendyline/squisq/schemas');
  return getAvailableThemes();
}

/**
 * Reject an explicit theme typo instead of allowing a renderer to fall back.
 * Document-embedded custom IDs can be supplied by callers that have already
 * imported the document.
 */
export async function assertKnownThemeId(
  themeId: string | undefined,
  customThemeIds: readonly string[] = [],
): Promise<void> {
  if (!themeId) return;
  const builtInThemeIds = await getAvailableThemeIds();
  if (builtInThemeIds.includes(themeId) || customThemeIds.includes(themeId)) return;
  throw new Error(`Unknown theme "${themeId}". Available: ${builtInThemeIds.join(', ')}`);
}
