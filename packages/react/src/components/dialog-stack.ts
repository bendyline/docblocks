const closers: Array<() => void> = [];
export function registerDialogCloser(close: () => void): () => void {
  closers.push(close);
  return () => {
    const index = closers.indexOf(close);
    if (index >= 0) closers.splice(index, 1);
  };
}
export function isTopmostDialog(close: () => void): boolean {
  return closers[closers.length - 1] === close;
}
export function dismissTopmostDialog(): boolean {
  const close = closers[closers.length - 1];
  if (!close) return false;
  close();
  return true;
}
