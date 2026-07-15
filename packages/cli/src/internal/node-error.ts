/**
 * Narrow an unknown throw to a Node `errno` error carrying one of `codes`.
 *
 * Accepts a single code or a list so callers can keep grouping related codes
 * (`ENOENT`/`ENOTDIR` for absence, `EACCES`/`EPERM` for permission).
 */
export function isNodeErrorCode(
  error: unknown,
  codes: string | readonly string[],
): error is NodeJS.ErrnoException {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = String(error.code);
  return typeof codes === 'string' ? code === codes : codes.includes(code);
}
