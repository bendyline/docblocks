/**
 * Study-card guidance for the authoring guide and the focused authoring
 * context.
 *
 * A document can carry its own study material: flashcards and
 * multiple-choice questions kept under the section they test (Squisq
 * `{[flashcard]}` / `{[quiz]}` accessory blocks), studied in the Flashcards
 * view and left out of every export but Markdown and DocBlocks bundles. The
 * rules and the worked example are the linked Squisq's (`studyCardGuide`,
 * `STUDY_CARD_EXAMPLE`), where a test holds the example to the card reader,
 * so this module only chooses where to say them.
 */

/** Formats that keep study cards; every other export leaves them out. */
export const STUDY_CARD_FORMATS: readonly string[] = ['md', 'dbk'];

/** One paragraph for the focused authoring context, when the target keeps cards. */
export const STUDY_CARD_GUIDANCE =
  'To add study material, put flashcards (a heading tagged {[flashcard]} is the question, the text under it the answer) and multiple-choice questions (a heading tagged {[quiz]}, then a checklist of choices with exactly one ticked: "- [x] Right", "- [ ] Wrong") under the section they test, after its text. They are kept in Markdown and DocBlocks bundles and left out of every other export. docblocks://authoring-guide studyCards has the rules and an example.';

/** The study-cards section of `docblocks://authoring-guide`. */
export async function authoringGuideStudyCards() {
  const { STUDY_CARD_EXAMPLE, studyCardGuide } = await import('@bendyline/squisq/study');
  return {
    rules: studyCardGuide(),
    example: STUDY_CARD_EXAMPLE,
    keptIn: [...STUDY_CARD_FORMATS],
  };
}
