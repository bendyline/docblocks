export async function withApplyingEditFlag(
  setApplyingEdit: (isApplying: boolean) => void,
  applyEdit: () => Promise<void>,
): Promise<void> {
  setApplyingEdit(true);
  try {
    await applyEdit();
  } finally {
    setApplyingEdit(false);
  }
}
