/**
 * Fuzzy subsequence scoring for quick-open: every query character must
 * appear in order. Matches at word starts and in consecutive runs score
 * higher; skipped characters cost a little. Returns highlight ranges.
 */

import type { WorkspaceSearchRange } from './types.js';

export interface FuzzyMatch {
  readonly score: number;
  readonly ranges: readonly WorkspaceSearchRange[];
}

const SEPARATORS = new Set(['/', '\\', '-', '_', '.', ' ']);

const SCORE_MATCH = 16;
const BONUS_FIRST_CHARACTER = 24;
// Close to the first-character bonus: `rel` should find `gezel-release`
// ahead of a gappy hit that merely starts the name.
const BONUS_WORD_START = 20;
const BONUS_CONSECUTIVE = 12;
const BONUS_SAME_CASE = 1;
const PENALTY_GAP = 2;
const PENALTY_GAP_CAP = 24;
const PENALTY_LEADING = 1;

function isWordStart(target: string, index: number): boolean {
  if (index === 0) return true;
  const previous = target[index - 1]!;
  if (SEPARATORS.has(previous)) return true;
  const current = target[index]!;
  // camelCase boundary: lower → Upper.
  return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

function toRanges(indices: readonly number[]): WorkspaceSearchRange[] {
  const ranges: WorkspaceSearchRange[] = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) ranges[ranges.length - 1] = [last[0], index + 1];
    else ranges.push([index, index + 1]);
  }
  return ranges;
}

/**
 * Score one query token against a target, or null when it does not match.
 * Finds the earliest-ending match, then walks back to the tightest window
 * that still contains it, so `ab` in `a…xab` highlights the `ab` run.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, ranges: [] };
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();
  if (lowerQuery.length > lowerTarget.length) return null;

  // Forward: earliest position where the whole query has been seen.
  let queryIndex = 0;
  let end = -1;
  for (let index = 0; index < lowerTarget.length; index += 1) {
    if (lowerTarget[index] === lowerQuery[queryIndex]) {
      queryIndex += 1;
      if (queryIndex === lowerQuery.length) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return null;

  // Backward: the latest start that still completes the match by `end`.
  queryIndex = lowerQuery.length - 1;
  let start = end;
  for (let index = end; index >= 0; index -= 1) {
    if (lowerTarget[index] === lowerQuery[queryIndex]) {
      queryIndex -= 1;
      if (queryIndex < 0) {
        start = index;
        break;
      }
    }
  }

  // Forward again inside the window to collect the matched positions.
  const indices: number[] = [];
  queryIndex = 0;
  for (let index = start; index <= end && queryIndex < lowerQuery.length; index += 1) {
    if (lowerTarget[index] !== lowerQuery[queryIndex]) continue;
    indices.push(index);
    queryIndex += 1;
  }
  if (indices.length !== lowerQuery.length) return null;

  let score = 0;
  let previous = -2;
  for (let position = 0; position < indices.length; position += 1) {
    const index = indices[position]!;
    score += SCORE_MATCH;
    if (index === 0) score += BONUS_FIRST_CHARACTER;
    else if (isWordStart(target, index)) score += BONUS_WORD_START;
    if (index === previous + 1) score += BONUS_CONSECUTIVE;
    else if (previous >= 0)
      score -= Math.min(PENALTY_GAP * (index - previous - 1), PENALTY_GAP_CAP);
    if (target[index] === query[position]) score += BONUS_SAME_CASE;
    previous = index;
  }
  score -= Math.min(PENALTY_LEADING * indices[0]!, PENALTY_GAP_CAP);
  return { score, ranges: toRanges(indices) };
}

/**
 * Every whitespace-separated token must match. Scores add up; ranges merge.
 * Returns null when any token misses.
 */
export function fuzzyMatchTokens(tokens: readonly string[], target: string): FuzzyMatch | null {
  let score = 0;
  const marked = new Set<number>();
  for (const token of tokens) {
    const match = fuzzyMatch(token, target);
    if (!match) return null;
    score += match.score;
    for (const [rangeStart, rangeEnd] of match.ranges) {
      for (let index = rangeStart; index < rangeEnd; index += 1) marked.add(index);
    }
  }
  return { score, ranges: toRanges([...marked].sort((left, right) => left - right)) };
}

/** Split a quick-open query into tokens. */
export function fuzzyTokens(query: string): string[] {
  return query.trim().split(/\s+/u).filter(Boolean);
}
