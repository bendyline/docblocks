/**
 * Turn what the model wrote into the saved summary document.
 *
 * (Quiz questions and flashcards are study cards kept with each section,
 * compiled and checked by Squisq — see `Study/`.)
 */

import { sanitizeGeneratedMarkdown } from './ai-assistant.js';
import { stripReasoning } from './ai-json.js';
import { cleanLabel } from './diagram-sanitize.js';
import {
  STUDY_AID_LABELS,
  withStudyAidFrontmatter,
  type StudyAidKind,
  type StudyAidProvenance,
} from './study-aids.js';

const TITLE_CHARACTERS = 160;

/** Sanitized heading text that cannot end in a closing `#` sequence. */
function headingText(value: string, max: number): string {
  return cleanLabel(value, max).replace(/(^|\s)(#+)$/u, '$1\\$2');
}

/**
 * The model's summary as the body of the saved document: wrapper fences and
 * reasoning removed, a leading title dropped (the compiler writes its own),
 * and other headings demoted below the title.
 */
export function compileSummaryBody(reply: string): string {
  const lines = sanitizeGeneratedMarkdown(stripReasoning(reply)).split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker.charAt(0);
      else if (marker.charAt(0) === fence) fence = null;
      out.push(line);
      continue;
    }
    const heading = fence === null ? /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line) : null;
    if (heading) {
      if (out.every((earlier) => !earlier.trim())) continue;
      out.push(`### ${(heading[1] ?? '').replace(/\s+#+\s*$/u, '').trim()}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

function studyAidTitle(kind: StudyAidKind, documentTitle: string): string {
  return headingText(
    `${STUDY_AID_LABELS[kind].title}: ${documentTitle.trim() || 'Untitled'}`,
    TITLE_CHARACTERS,
  );
}

/** The saved summary: frontmatter, a title, and the compiled body. */
export function assembleSummary(
  body: string,
  documentTitle: string,
  provenance: StudyAidProvenance,
): string {
  const title = studyAidTitle('summary', documentTitle);
  return withStudyAidFrontmatter(`# ${title}\n\n${body}\n`, title, provenance);
}
