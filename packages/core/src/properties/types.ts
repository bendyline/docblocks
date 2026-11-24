/**
 * Document properties: the few frontmatter keys DocBlocks gives meaning to
 * beyond the document's own text. Any Markdown file may carry them, and a
 * task is simply a document that does.
 *
 * The keys are plain words (`due`, `tags`) rather than prefixed ones, so the
 * same files read naturally in other Markdown tools.
 */

import type { DueValue, LocalDate, RepeatRule } from './dates.js';

export interface DocumentProperties {
  /** When the document is due: a day, or a time on that day. */
  readonly due?: DueValue;
  /** One grouping, shown as a colour. */
  readonly category?: string;
  readonly tags?: readonly string[];
  /** How often it comes due again once done. */
  readonly repeat?: RepeatRule;
  /**
   * Done: the day it was finished, or `true` when another tool marked it
   * done without saying when.
   */
  readonly completed?: LocalDate | true;
}

/** A change to properties: a value sets the key, `null` removes it, absent leaves it. */
export type DocumentPropertiesPatch = {
  readonly [Key in keyof DocumentProperties]?: DocumentProperties[Key] | null;
};

/** Frontmatter keys, in the order new ones are written. */
export const DOCUMENT_PROPERTY_KEYS = ['due', 'category', 'tags', 'repeat', 'completed'] as const;
export type DocumentPropertyKey = (typeof DOCUMENT_PROPERTY_KEYS)[number];

export const DOCUMENT_PROPERTY_LIMITS = {
  maxCategoryCharacters: 64,
  maxTags: 32,
  maxTagCharacters: 64,
  /** Frontmatter read from a document too large to parse whole. */
  maxFrontmatterBytes: 64 * 1024,
} as const;

/** Whether the properties say the document is done. */
export function isCompleted(properties: Pick<DocumentProperties, 'completed'>): boolean {
  return properties.completed !== undefined;
}

/** The day it was done, when that is known. */
export function completedOn(properties: Pick<DocumentProperties, 'completed'>): LocalDate | null {
  return typeof properties.completed === 'string' ? properties.completed : null;
}
