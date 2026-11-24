/**
 * Write document properties into a Markdown source's frontmatter.
 *
 * The rewrite is Squisq's `setFrontmatterValues`: it touches only the keys
 * named, keeps every other line and the key order, and adds a frontmatter
 * block when the document has none. The result is new source text for the
 * caller to save through whatever owns the document (the open document's
 * session, or a conditional write for a closed one).
 */

import { REPEAT_RULES, isLocalDate, normalizeDue } from './dates.js';
import {
  DOCUMENT_PROPERTY_KEYS,
  DOCUMENT_PROPERTY_LIMITS,
  type DocumentPropertiesPatch,
} from './types.js';

type MarkdownModule = typeof import('@bendyline/squisq/markdown');

let markdownModule: Promise<MarkdownModule> | null = null;
function loadMarkdown(): Promise<MarkdownModule> {
  markdownModule ??= import('@bendyline/squisq/markdown');
  return markdownModule;
}

/** A value offered for a property cannot be written as that property. */
export class DocumentPropertyError extends Error {
  public constructor(
    public readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentPropertyError';
  }
}

type FrontmatterUpdate = string | boolean | null | readonly string[];

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function tagList(values: readonly string[]): readonly string[] | null {
  const tags: string[] = [];
  for (const value of values) {
    const tag = collapse(value)
      .replace(/^#/, '')
      .slice(0, DOCUMENT_PROPERTY_LIMITS.maxTagCharacters)
      .trimEnd();
    // A comma would split the tag in two when another tool reads a flow list.
    if (tag.includes(',')) throw new DocumentPropertyError('tags', 'A tag cannot contain a comma.');
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > DOCUMENT_PROPERTY_LIMITS.maxTags) {
    throw new DocumentPropertyError(
      'tags',
      `A document can carry up to ${DOCUMENT_PROPERTY_LIMITS.maxTags} tags.`,
    );
  }
  return tags.length > 0 ? tags : null;
}

/**
 * The frontmatter updates a patch amounts to, in the order new keys are
 * written. `null` removes a key. Throws `DocumentPropertyError` for a value
 * that is not a valid form of its property.
 */
export function documentPropertyUpdates(
  patch: DocumentPropertiesPatch,
): Record<string, FrontmatterUpdate> {
  const updates: Record<string, FrontmatterUpdate> = {};
  for (const key of DOCUMENT_PROPERTY_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) {
      updates[key] = null;
      continue;
    }
    switch (key) {
      case 'due': {
        const due = normalizeDue(value);
        if (!due) throw new DocumentPropertyError(key, 'A due date must be a calendar date.');
        updates[key] = due;
        break;
      }
      case 'category': {
        const category = collapse(String(value));
        if (category.length > DOCUMENT_PROPERTY_LIMITS.maxCategoryCharacters) {
          throw new DocumentPropertyError(key, 'That category name is too long.');
        }
        updates[key] = category || null;
        break;
      }
      case 'tags':
        updates[key] = tagList(value as readonly string[]);
        break;
      case 'repeat':
        if (!(REPEAT_RULES as readonly string[]).includes(String(value))) {
          throw new DocumentPropertyError(key, 'That is not a repeat rule.');
        }
        updates[key] = String(value);
        break;
      case 'completed':
        if (value !== true && !isLocalDate(value)) {
          throw new DocumentPropertyError(key, 'A completion date must be a calendar date.');
        }
        updates[key] = value as string | true;
        break;
    }
  }
  return updates;
}

/**
 * `source` with the patch applied to its frontmatter. Returns `source`
 * itself when the patch changes nothing.
 */
export async function applyDocumentProperties(
  source: string,
  patch: DocumentPropertiesPatch,
): Promise<string> {
  const updates = documentPropertyUpdates(patch);
  if (Object.keys(updates).length === 0) return source;
  const { setFrontmatterValues } = await loadMarkdown();
  const next = setFrontmatterValues(source, updates);
  // A block Squisq had to create sits flush against the first line of text.
  // Set it off with a blank line, as every Markdown tool writes it.
  if (next !== source && next.endsWith(source) && source !== '' && !/^\r?\n/.test(source)) {
    const block = next.slice(0, next.length - source.length);
    if (block.startsWith('---')) return `${block}\n${source}`;
  }
  return next;
}
