/**
 * The choices for a new-file type `<select>`, one per `NewFileFormat`.
 * Used by the explorer's inline new-file form and the New document dialog.
 *
 * Only Markdown is a document type of its own. The rest are written in
 * Markdown and saved as another format, so they are grouped under that
 * rather than presented as editors for Word, Excel or PDF files.
 */
export function NewFileFormatOptions() {
  return (
    <>
      <option value="markdown">Markdown (.md)</option>
      <optgroup label="Written in Markdown, saved as">
        <option value="docx">Word document (.docx)</option>
        <option value="xlsx">Excel workbook (.xlsx)</option>
        <option value="pdf">PDF (.pdf)</option>
        <option value="web-interactive">Web page — Interactive (.html)</option>
        <option value="web-static">Web page — Static (.html)</option>
      </optgroup>
    </>
  );
}
