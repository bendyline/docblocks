/** Strip Electron's IPC envelope so a host's actionable message reads on its own. */
export function hostErrorDetail(caught: unknown): string {
  return caught instanceof Error
    ? caught.message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '').trim()
    : '';
}
