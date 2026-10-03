/**
 * Gezel's full-service file search is outside DocBlocks' inference-only profile.
 * Keep its glob implementation out of the desktop artifact, including braces
 * (GHSA-VFJ7-8CJW-P6XM), until upstream publishes a fixed implementation.
 */
export const excludedDesktopDependencies = new Set(['braces', 'fast-glob', 'micromatch']);

export const desktopDependencyExclusions = [
  '!node_modules/{braces,fast-glob,micromatch}/**/*',
  '!node_modules/**/node_modules/{braces,fast-glob,micromatch}/**/*',
] as const;
