export interface OpenAfterSaveControl {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function OpenAfterSaveCheckbox({
  checked,
  onChange,
  disabled,
}: OpenAfterSaveControl & { disabled?: boolean }) {
  return (
    <label className="db-export-checkbox db-export-open-after-save">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Open in app after saving</span>
    </label>
  );
}
