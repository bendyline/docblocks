/**
 * Re-focus an already-open find bar and select its query. Squisq focuses the
 * input only when the bar mounts, so a repeated Ctrl/Cmd+F needs this.
 */
export function focusFindInput(scope: ParentNode = document): void {
  const input = scope.querySelector<HTMLInputElement>('.squisq-find-input');
  input?.focus();
  input?.select();
}
