/**
 * Review styles: the lenses the Review panel reads a document through.
 *
 * Each style is a different brief for the same reviewer. They share the
 * findings contract in `buildReviewRequest` (an exact quote, an optional
 * replacement, a category and a severity), so every style flags text and
 * offers fixes the same way in the panel.
 */

export type AiReviewStyle =
  | 'general'
  | 'facts'
  | 'creative'
  | 'resume'
  | 'concise'
  | 'strunk'
  | 'un'
  | 'plain';

export interface AiReviewStyleDefinition {
  /** The option in the panel's Review style list. */
  readonly label: string;
  /** One line under the list saying what the style looks for. */
  readonly description: string;
  /** What the reviewer looks for, and the categories it names findings with. */
  readonly brief: string;
  readonly temperature: number;
}

export const AI_REVIEW_STYLES: readonly AiReviewStyle[] = [
  'general',
  'facts',
  'creative',
  'resume',
  'concise',
  'strunk',
  'un',
  'plain',
];

export const AI_REVIEW_STYLE_DEFINITIONS: Readonly<Record<AiReviewStyle, AiReviewStyleDefinition>> =
  {
    general: {
      label: 'General',
      description: 'Clarity, structure, tone and consistency.',
      brief:
        'Find meaningful issues in clarity, structure, tone, consistency, and unsupported or ambiguous ' +
        'wording. Leave authorial choices that are already clear alone.',
      temperature: 0.2,
    },
    facts: {
      label: 'Facts and sources',
      description: 'Checks factual claims and flags the ones that need a source.',
      // Local models supply names, dates and citations from memory fluently and
      // wrongly, so this style may point at a gap but never fill it.
      brief:
        'Check the factual claims a reader would rely on: names, dates, numbers, statistics, quotations, ' +
        'and claims about causes, records or consensus. Flag a claim that no source, link or citation in the ' +
        'document supports, a claim that may be wrong or out of date, and a claim stated more certainly than ' +
        'its support allows. When a reference passage given with this request confirms or contradicts a ' +
        'claim, say which. Never invent a source, link or citation, and never supply a name, date or number ' +
        'that no reference passage shows. When a claim needs a source, set "replacement" to null and say in ' +
        '"rationale" what kind of source would support it. Offer a replacement only to qualify an overstated ' +
        'claim or to correct one that a reference passage contradicts. Use a category such as "Needs source", ' +
        '"Check accuracy" or "Overstated".',
      temperature: 0.2,
    },
    creative: {
      label: 'Creative ideas',
      description: 'Suggests fresher, more vivid ways to make each point.',
      brief:
        'Suggest creative ways to make passages more vivid, original and engaging: a sharper opening, a ' +
        'concrete example or image, a fresh angle, a stronger heading, or a livelier turn of phrase. Quote the ' +
        'passage each idea would improve and give the reworked passage as "replacement", or null when the ' +
        'idea needs material only the author has, saying in "rationale" what to add. Keep the author\'s ' +
        'purpose, voice and facts; add no name, date, number, place or quotation the document does not show. ' +
        'Use "suggestion" as the severity and a category such as "Opening", "Imagery", "Example", "Angle" or ' +
        '"Heading".',
      temperature: 0.6,
    },
    resume: {
      label: 'Resume',
      description: 'Reads the document as a resume, by the practices that make resumes work.',
      brief:
        'Review this document as a resume, by the practices that make resumes effective. Look for bullets ' +
        'that list duties ("responsible for") instead of accomplishments; bullets that should lead with a ' +
        'strong action verb; results that would land harder with a measurable outcome; first-person pronouns; ' +
        'inconsistent tense (present for the current role, past for earlier ones), date formats or punctuation ' +
        'across entries; entries out of reverse-chronological order; vague claims and cliches such as "team ' +
        'player" or "hard-working"; bullets longer than two lines; a missing or generic summary; and dated or ' +
        'unneeded items such as an objective statement, "References available upon request", or personal ' +
        'details such as age or marital status. Never invent an employer, title, date, skill or metric. When ' +
        'a bullet needs a number only the author knows, set "replacement" to null and say in "message" what ' +
        'to quantify. Use a category such as "Impact", "Action verb", "Quantify", "Consistency", "Concision" ' +
        'or "Relevance".',
      temperature: 0.2,
    },
    concise: {
      label: 'Conciseness',
      description: 'Finds ways to say the same thing in fewer words.',
      brief:
        'Find passages that can say the same thing in fewer words: redundant pairs and repeated points, ' +
        'filler and empty qualifiers ("very", "really", "basically"), wordy phrases ("in order to", "due to ' +
        'the fact that"), nouns made from verbs ("make a decision" for "decide"), needless passive voice, and ' +
        'throat-clearing openings. Every finding must have a "replacement" that is shorter than its quote and ' +
        'keeps all of its meaning, facts, links and Markdown formatting. Use "suggestion" as the severity and ' +
        'a category such as "Redundancy", "Filler", "Wordy phrase" or "Repetition".',
      temperature: 0.2,
    },
    strunk: {
      label: 'The Elements of Style',
      description: 'Strunk and White: active voice, positive form, omit needless words.',
      brief:
        'Review by the rules of The Elements of Style by Strunk and White: use the active voice; put ' +
        'statements in positive form; use definite, specific, concrete language; omit needless words; avoid ' +
        'a succession of loose sentences; express coordinate ideas in similar form; keep related words ' +
        'together; in summaries, keep to one tense; place the emphatic words of a sentence at the end; make ' +
        'the paragraph the unit of composition; do not join independent clauses with a comma; in a series of ' +
        'three or more terms, use a comma after each term but the last; and make an opening participial ' +
        'phrase refer to the grammatical subject. Name the rule as the category, such as "Omit needless ' +
        'words" or "Use the active voice".',
      temperature: 0.2,
    },
    un: {
      label: 'UN Editorial Manual',
      description: 'United Nations style: spelling, numbers, dates, names and terms.',
      brief:
        'Review by the United Nations Editorial Manual. Check spelling by the Concise Oxford English ' +
        'Dictionary as the United Nations applies it (organization, programme, centre, labour); numbers ' +
        'under 10 spelled out and figures from 10 up, except percentages, ages, temperatures and votes, which ' +
        'take figures, and a number that starts a sentence, which is spelled out; commas as thousands ' +
        'separators in text (2,632,597) and a zero before a decimal point (0.85); "%" or "per cent" used ' +
        'consistently; dates as day, month in full, year (21 April 2004); times as 9 a.m. and 1.30 p.m.; ' +
        'decades as "the 1990s" and centuries spelled out ("nineteenth century"); the official names the ' +
        'United Nations uses for countries (Türkiye, Republic of Korea); a full name before its abbreviation ' +
        'at first use; "Member States" and "Secretary-General" capitalized; gender-inclusive language; and a ' +
        'formal, neutral tone. Use a category such as "Spelling", "Numbers", "Dates", "Terminology", ' +
        '"Capitalization" or "Inclusive language".',
      temperature: 0.2,
    },
    plain: {
      label: 'Plain language',
      description: 'The US Federal Plain Language Guidelines: short, direct, reader-first.',
      brief:
        'Review by the US Federal Plain Language Guidelines: write for the reader and address them as ' +
        '"you"; use the active voice; keep sentences short (about 20 words) and paragraphs short; choose ' +
        'common, everyday words over jargon, legalese and abstract nouns; use "must" rather than "shall" for ' +
        'a requirement; keep the subject, verb and object close together; put the main point first; define ' +
        'terms and abbreviations a reader may not know; and use useful headings and lists to break up dense ' +
        'text. Use a category such as "Active voice", "Long sentence", "Jargon", "Address the reader", "Main ' +
        'point first" or "Structure".',
      temperature: 0.2,
    },
  };

export function isAiReviewStyle(value: string): value is AiReviewStyle {
  return Object.prototype.hasOwnProperty.call(AI_REVIEW_STYLE_DEFINITIONS, value);
}
