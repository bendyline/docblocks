/**
 * Read document properties out of parsed frontmatter.
 *
 * Reading is tolerant: frontmatter is written by people and by other tools,
 * so a value that cannot be understood is left out of the result. It is never
 * an error, and nothing here changes the file.
 */

import { REPEAT_RULES, isLocalDate, localDateOf, normalizeDue, type RepeatRule } from './dates.js';
import { DOCUMENT_PROPERTY_LIMITS, type DocumentProperties } from './types.js';

type Frontmatter = Readonly<Record<string, unknown>>;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * The items of a frontmatter list, however it was written. Squisq's reader
 * keeps a YAML flow list (`[a, b]`) as text, and people also write `a, b`.
 */
export function splitFrontmatterList(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  return raw
    .replace(/^\s*\[|\]\s*$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^(["'])(.*)\1$/, '$2'));
}

function readDue(value: unknown): string | undefined {
  // A parser that understands YAML dates hands over a Date at UTC midnight.
  if (validDate(value)) return value.toISOString().slice(0, 10);
  return normalizeDue(value) ?? undefined;
}

function readCategory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = collapse(value).slice(0, DOCUMENT_PROPERTY_LIMITS.maxCategoryCharacters).trimEnd();
  return text || undefined;
}

function readTags(frontmatter: Frontmatter): string[] | undefined {
  const tags: string[] = [];
  for (const value of splitFrontmatterList(frontmatter.tags ?? frontmatter.keywords)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const tag = collapse(String(value))
      .replace(/^#/, '')
      .slice(0, DOCUMENT_PROPERTY_LIMITS.maxTagCharacters)
      .trimEnd();
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= DOCUMENT_PROPERTY_LIMITS.maxTags) break;
  }
  return tags.length > 0 ? tags : undefined;
}

function readRepeat(value: unknown): RepeatRule | undefined {
  if (typeof value !== 'string') return undefined;
  const rule = value.trim().toLowerCase();
  return (REPEAT_RULES as readonly string[]).includes(rule) ? (rule as RepeatRule) : undefined;
}

function readCompleted(value: unknown): string | true | undefined {
  if (value === true) return true;
  if (validDate(value)) return value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^(true|yes)$/i.test(text)) return true;
  // A full timestamp says when; the day is what a task list needs.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    const instant = new Date(text);
    const day = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text)
      ? Number.isFinite(instant.getTime())
        ? localDateOf(instant)
        : null
      : text.slice(0, 10);
    return day && isLocalDate(day) ? day : undefined;
  }
  return isLocalDate(text) ? text : undefined;
}

/** The properties a document's frontmatter carries. */
export function readDocumentProperties(frontmatter: Frontmatter | undefined): DocumentProperties {
  if (!frontmatter) return {};
  const due = readDue(frontmatter.due);
  const category = readCategory(frontmatter.category);
  const tags = readTags(frontmatter);
  const repeat = readRepeat(frontmatter.repeat);
  const completed = readCompleted(frontmatter.completed);
  return {
    ...(due ? { due } : {}),
    ...(category ? { category } : {}),
    ...(tags ? { tags } : {}),
    ...(repeat ? { repeat } : {}),
    ...(completed !== undefined ? { completed } : {}),
  };
}

/** True when a document carries a property that makes it task-like. */
export function hasTaskProperties(properties: DocumentProperties): boolean {
  return properties.due !== undefined || properties.completed !== undefined;
}
