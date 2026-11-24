/**
 * Count a document's checklist items (`- [ ]` and `- [x]`), wherever they
 * are nested. A task's steps are ordinary checklist lines, so its progress is
 * read from the text rather than stored beside it.
 */

export interface ChecklistProgress {
  readonly done: number;
  readonly total: number;
}

interface TreeNode {
  readonly type?: unknown;
  readonly checked?: unknown;
  readonly children?: unknown;
}

function isNode(value: unknown): value is TreeNode {
  return typeof value === 'object' && value !== null;
}

/**
 * Progress through the checklist items in a parsed Markdown tree (Squisq's
 * `MarkdownDocument`, or any node of one). Undefined when there are none.
 */
export function countChecklist(root: unknown): ChecklistProgress | undefined {
  let done = 0;
  let total = 0;
  // Iterative: a pathological document nests deeper than the call stack allows.
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isNode(node)) continue;
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      total += 1;
      if (node.checked) done += 1;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) pending.push(child);
    }
  }
  return total > 0 ? { done, total } : undefined;
}

const CHECKLIST_LINE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s/;

/**
 * The same count from raw source lines, for a document too large to parse.
 * It cannot tell a checklist line inside a code block from a real one.
 */
export function countChecklistLines(source: string): ChecklistProgress | undefined {
  let done = 0;
  let total = 0;
  for (const line of source.split('\n')) {
    const match = CHECKLIST_LINE.exec(line);
    if (!match) continue;
    total += 1;
    if (match[1] !== ' ') done += 1;
  }
  return total > 0 ? { done, total } : undefined;
}
