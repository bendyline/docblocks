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

export function RefreshIcon() {
  return <FontAwesomeIcon icon="fa-solid fa-arrows-rotate" />;
}

export function MoreIcon() {
  return <FontAwesomeIcon icon="fa-solid fa-ellipsis" />;
}

export function WorkspaceIcon() {
  return <FontAwesomeIcon icon="fa-solid fa-gear" />;
}
