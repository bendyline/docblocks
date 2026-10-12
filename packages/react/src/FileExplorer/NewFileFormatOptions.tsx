/**
 * The option groups for a new-file type `<select>`, one per `NewFileFormat`.
 * Used by the explorer's inline new-file form and the New document dialog.
 */
export function NewFileFormatOptions() {
  return (
    <>
      <optgroup label="Document">
        <option value="markdown">Markdown (.md)</option>
        <option value="docx">Word document (.docx)</option>
        <option value="xlsx">Excel workbook (.xlsx)</option>
        <option value="pdf">PDF document (.pdf)</option>
      </optgroup>
      <optgroup label="Web page">
        <option value="web-interactive">Web page — Interactive (.html)</option>
        <option value="web-static">Web page — Static (.html)</option>
      </optgroup>
    </>
  );
}
