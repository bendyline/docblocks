/**
 * Return whether two document snapshots differ by more than whitespace.
 *
 * VS Code's DocBlocks webview is allowed to hydrate and navigate without
 * authoring a file edit. Before the user's first substantive edit, hosts use
 * this comparison to discard serializer churn that only changes line breaks,
 * indentation, or other whitespace.
 */
export function hasSubstantiveTextChange(baseline: string, candidate: string): boolean {
  let baselineIndex = 0;
  let candidateIndex = 0;

  while (true) {
    baselineIndex = skipWhitespace(baseline, baselineIndex);
    candidateIndex = skipWhitespace(candidate, candidateIndex);

    const baselineEnded = baselineIndex === baseline.length;
    const candidateEnded = candidateIndex === candidate.length;
    if (baselineEnded || candidateEnded) return baselineEnded !== candidateEnded;
    if (baseline[baselineIndex] !== candidate[candidateIndex]) return true;

    baselineIndex += 1;
    candidateIndex += 1;
  }
}

const WHITESPACE_CHARACTER = /\s/u;

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && WHITESPACE_CHARACTER.test(value[index])) index += 1;
  return index;
}
