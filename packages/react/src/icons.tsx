/**
 * DocBlocks shell icons use the Font Awesome Free webfont bundled by
 * `@bendyline/squisq-editor-react/styles`. Controls provide the accessible
 * name, so the glyphs themselves stay decorative.
 */

function FontAwesomeIcon({ icon }: { icon: string }) {
  return <i className={icon} aria-hidden="true" />;
}

export function NewFileIcon() {
  return <FontAwesomeIcon icon="fa-solid fa-file-circle-plus" />;
}

export function NewFolderIcon() {
  return <FontAwesomeIcon icon="fa-solid fa-folder-plus" />;
}

export function FolderIcon() {
  return <FontAwesomeIcon icon="fa-solid fa-folder" />;
}

export function MoreIcon() {
  return <FontAwesomeIcon icon="fa-solid fa-ellipsis" />;
}

export function WorkspaceIcon() {
  return <FontAwesomeIcon icon="fa-solid fa-gear" />;
}

export function SplitViewIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" />
    </svg>
  );
}
