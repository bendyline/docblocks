/**
 * PDF export stopped before anything was saved because the PDF fonts would
 * replace some of the document's characters (CJK text and most emoji). The
 * user can save it anyway with the replacements, or pick a format that keeps
 * every character.
 *
 * Kept out of `run-export.ts` so the export controls can recognise it without
 * loading the export pipeline.
 */
export class PdfReplacementsError extends Error {
  /** Squisq's account of what would be replaced, for the message. */
  readonly replacements: readonly string[];

  constructor(replacements: readonly string[]) {
    super(
      'PDF was not saved because its fonts cannot draw all of this document’s text. ' +
        'Save it with the replacements, or export as Word, HTML, or EPUB to keep every character. ' +
        replacements.join(' '),
    );
    this.name = 'PdfReplacementsError';
    this.replacements = replacements;
  }
}
