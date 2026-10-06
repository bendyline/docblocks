/**
 * Pull one JSON value out of a model reply.
 *
 * Small local models wrap JSON in prose, code fences, or a reasoning block,
 * and often leave a trailing comma. None of that is worth failing on; a reply
 * that holds no complete value is, and the problem text says why so a repair
 * prompt can be specific.
 */

export type JsonShape = 'object' | 'array';

export type JsonExtraction =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: string };

const MAX_CANDIDATES = 8;

/** Remove `<think>…</think>`-style reasoning a model emitted before its answer. */
function stripReasoning(text: string): string {
  return text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/giu, '').trim();
}

function stripFence(text: string): string {
  const fenced = /```(?:json|javascript|js)?\s*\n([\s\S]*?)\n?```/iu.exec(text);
  return fenced?.[1] ?? text;
}

/** The balanced value starting at `start`, honoring strings and escapes. */
function balancedValue(text: string, start: number): string | null {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return char === close ? text.slice(start, i + 1) : null;
    }
  }
  return null;
}

function parseLenient(candidate: string): { ok: true; value: unknown } | null {
  for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/gu, '$1')]) {
    try {
      return { ok: true, value: JSON.parse(attempt) as unknown };
    } catch {
      // Try the next repair.
    }
  }
  return null;
}

/** Extract the first complete JSON object or array of the requested shape. */
export function extractJson(text: string, shape: JsonShape): JsonExtraction {
  if (
    /<(think|thinking|reasoning)>/iu.test(text) &&
    !/<\/(think|thinking|reasoning)>/iu.test(text)
  ) {
    return { ok: false, problem: 'The reply ended while still reasoning, before any JSON.' };
  }
  const body = stripFence(stripReasoning(text));
  const opener = shape === 'object' ? '{' : '[';
  let sawOpener = false;
  let tried = 0;
  for (
    let i = body.indexOf(opener);
    i >= 0 && tried < MAX_CANDIDATES;
    i = body.indexOf(opener, i + 1)
  ) {
    sawOpener = true;
    tried++;
    const candidate = balancedValue(body, i);
    if (candidate === null) continue;
    const parsed = parseLenient(candidate);
    if (!parsed) continue;
    const isArray = Array.isArray(parsed.value);
    const matches =
      shape === 'array'
        ? isArray
        : typeof parsed.value === 'object' && parsed.value !== null && !isArray;
    if (matches) return parsed;
  }
  if (!sawOpener) {
    return {
      ok: false,
      problem:
        shape === 'object' ? 'The reply has no JSON object.' : 'The reply has no JSON array.',
    };
  }
  return {
    ok: false,
    problem:
      shape === 'object'
        ? 'The JSON object is incomplete or invalid (it may have been cut off).'
        : 'The JSON array is incomplete or invalid (it may have been cut off).',
  };
}
