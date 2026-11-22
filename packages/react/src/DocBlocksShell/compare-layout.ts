/**
 * Whether the window is laid out for a phone, read once from the attributes
 * the shell stamps on the document. For choosing a starting state only: the
 * layout itself follows the stylesheet, which keeps up with resizing.
 */
export function startsOnPhoneLayout(): boolean {
  if (typeof document === 'undefined') return false;
  const { dbWidth, dbFormFactor } = document.documentElement.dataset;
  return dbWidth === 'compact' || dbFormFactor === 'phone';
}
