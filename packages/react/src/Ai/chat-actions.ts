/**
 * What Ask can offer to do after an answer: create tasks, notes and journal
 * lines, and, only once the person allows edits for the conversation, change
 * the properties of documents the answer cited or add to them.
 *
 * The model proposes; nothing happens until the person confirms. Proposals
 * come back as structured output (a JSON value matching a schema), which
 * every DocBlocks host can carry, rather than as tool calls, which not every
 * engine supports. Each proposal is checked here before it is shown: unknown
 * kinds, documents the answer did not cite, and anything malformed are
 * dropped.
 */

import type { AiChatRequest, AiResponseFormat } from '@bendyline/docblocks/host';
import { applyDocumentProperties, normalizeDue } from '@bendyline/docblocks/properties';
import type { PageActions } from '../Home/page-actions.js';

export const ACTION_LIMITS = {
  maxActions: 12,
  maxTitle: 160,
  maxText: 4_000,
  maxTags: 8,
} as const;

/** A document an edit may target: one the answer cited. */
export interface ActionTarget {
  readonly path: string;
  readonly title: string;
}

export type ProposedAction =
  | {
      readonly kind: 'create-task';
      readonly title: string;
      readonly due?: string;
      readonly category?: string;
      readonly notes?: string;
    }
  | { readonly kind: 'create-note'; readonly title: string; readonly markdown: string }
  | { readonly kind: 'add-journal-entry'; readonly text: string }
  | {
      readonly kind: 'set-properties';
      readonly path: string;
      readonly title: string;
      readonly due?: string | null;
      readonly category?: string | null;
      readonly tags?: readonly string[];
    }
  | {
      readonly kind: 'append-to-document';
      readonly path: string;
      readonly title: string;
      readonly markdown: string;
    };

const ACTION_KINDS = [
  'create_task',
  'create_note',
  'add_journal_entry',
  'set_properties',
  'append_to_document',
] as const;

/**
 * One flat object per action, optional fields by kind: grammar-constrained
 * engines handle this more reliably than a union of shapes.
 */
export const ACTIONS_RESPONSE_FORMAT: AiResponseFormat = {
  type: 'json_schema',
  name: 'docblocks_actions',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['actions'],
    properties: {
      actions: {
        type: 'array',
        maxItems: ACTION_LIMITS.maxActions,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: {
            type: { type: 'string', enum: [...ACTION_KINDS] },
            title: { type: 'string' },
            due: { type: 'string', description: 'YYYY-MM-DD, or YYYY-MM-DDTHH:mm' },
            category: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            text: { type: 'string' },
            markdown: { type: 'string' },
            path: { type: 'string' },
          },
        },
      },
    },
  },
};

export const ACTIONS_SYSTEM_PROMPT =
  "You turn an answer about the person's notes into actions they can confirm. Propose only what " +
  'the conversation clearly calls for, and nothing at all when it calls for nothing. Kinds: ' +
  'create_task (title, optional due as YYYY-MM-DD and category), create_note (title and markdown), ' +
  'add_journal_entry (text, one line). Use the dates in the task facts to resolve words such as ' +
  '"tomorrow". Never invent details the conversation does not contain.';

export const ACTIONS_EDIT_PROMPT =
  'The person allows edits in this conversation. You may also propose set_properties (path, and ' +
  'any of due, category, tags) and append_to_document (path and markdown to add at the end), but ' +
  'only for the documents listed as editable, by their exact path.';

export function actionsRequest(input: {
  readonly question: string;
  readonly answer: string;
  readonly facts: string | null;
  readonly allowEdits: boolean;
  readonly targets: readonly ActionTarget[];
}): AiChatRequest {
  const system = [ACTIONS_SYSTEM_PROMPT, ...(input.allowEdits ? [ACTIONS_EDIT_PROMPT] : [])].join(
    '\n\n',
  );
  const parts = [
    `Question: ${input.question}`,
    `Answer: ${input.answer}`,
    ...(input.facts ? [`Task facts:\n${input.facts}`] : []),
    ...(input.allowEdits && input.targets.length > 0
      ? [
          `Editable documents:\n${input.targets
            .map((target) => `- ${target.path} (${target.title})`)
            .join('\n')}`,
        ]
      : []),
    'Reply with the actions as JSON.',
  ];
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: parts.join('\n\n') },
    ],
    purpose: 'chat',
    responseFormat: ACTIONS_RESPONSE_FORMAT,
    // Everything the model needs is in the prompt; more passages would only distract.
    searchKnowledge: false,
    temperature: 0,
  };
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function block(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, ACTION_LIMITS.maxText) : null;
}

/** The JSON object in a reply, tolerating a fenced block or prose around it. */
function jsonOf(reply: string): unknown {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The actions a reply proposes that can be offered, in order. */
export function parseProposedActions(
  reply: string,
  options: { readonly allowEdits: boolean; readonly targets: readonly ActionTarget[] },
): ProposedAction[] {
  const value = jsonOf(reply);
  if (typeof value !== 'object' || value === null) return [];
  const actions = (value as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  const targets = new Map(options.targets.map((target) => [target.path, target]));
  const proposed: ProposedAction[] = [];
  const seen = new Set<string>();
  for (const raw of actions) {
    if (proposed.length >= ACTION_LIMITS.maxActions) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    let action: ProposedAction | null = null;
    switch (entry.type) {
      case 'create_task': {
        const title = text(entry.title, ACTION_LIMITS.maxTitle);
        if (!title) break;
        const due = entry.due === undefined ? null : normalizeDue(entry.due);
        const category = text(entry.category, 64);
        const notes = block(entry.text ?? entry.markdown);
        action = {
          kind: 'create-task',
          title,
          ...(due ? { due } : {}),
          ...(category ? { category } : {}),
          ...(notes ? { notes } : {}),
        };
        break;
      }
      case 'create_note': {
        const title = text(entry.title, ACTION_LIMITS.maxTitle);
        const markdown = block(entry.markdown ?? entry.text);
        if (title && markdown) action = { kind: 'create-note', title, markdown };
        break;
      }
      case 'add_journal_entry': {
        const line = text(entry.text, 500);
        if (line) action = { kind: 'add-journal-entry', text: line };
        break;
      }
      case 'set_properties':
      case 'append_to_document': {
        if (!options.allowEdits || typeof entry.path !== 'string') break;
        const target = targets.get(entry.path.replace(/^\/+/, ''));
        if (!target) break;
        if (entry.type === 'append_to_document') {
          const markdown = block(entry.markdown ?? entry.text);
          if (markdown) {
            action = {
              kind: 'append-to-document',
              path: target.path,
              title: target.title,
              markdown,
            };
          }
          break;
        }
        // An empty or malformed field is no change, never a deletion: small
        // models fill every field of the schema. Clearing a property is left
        // to the properties row.
        const due = normalizeDue(entry.due) ?? undefined;
        const category = text(entry.category, 64) ?? undefined;
        const tagList = Array.isArray(entry.tags)
          ? entry.tags
              .map((tag) => text(tag, 64))
              .filter((tag): tag is string => tag !== null && !tag.includes(','))
              .slice(0, ACTION_LIMITS.maxTags)
          : [];
        const tags = tagList.length > 0 ? tagList : undefined;
        if (due === undefined && category === undefined && tags === undefined) break;
        action = {
          kind: 'set-properties',
          path: target.path,
          title: target.title,
          ...(due !== undefined ? { due } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(tags !== undefined ? { tags } : {}),
        };
        break;
      }
    }
    if (!action) continue;
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    proposed.push(action);
  }
  return proposed;
}

/** One line saying what an action will do, for the confirmation card. */
export function describeAction(action: ProposedAction): string {
  switch (action.kind) {
    case 'create-task':
      return `New task “${action.title}”${action.due ? `, due ${action.due}` : ''}${
        action.category ? ` (${action.category})` : ''
      }`;
    case 'create-note':
      return `New note “${action.title}” in Unfiled`;
    case 'add-journal-entry':
      return `Add to today’s journal: “${action.text}”`;
    case 'set-properties': {
      const changes = [
        action.due !== undefined ? (action.due ? `due ${action.due}` : 'no due date') : null,
        action.category !== undefined
          ? action.category
            ? `category ${action.category}`
            : 'no category'
          : null,
        action.tags !== undefined ? `tags ${action.tags.join(', ') || 'none'}` : null,
      ].filter(Boolean);
      return `Change “${action.title}”: ${changes.join(', ')}`;
    }
    case 'append-to-document':
      return `Add to the end of “${action.title}”`;
  }
}

export function isEdit(action: ProposedAction): boolean {
  return action.kind === 'set-properties' || action.kind === 'append-to-document';
}

export type ProposalRunner = Pick<
  PageActions,
  'addDescribedTask' | 'saveNote' | 'appendToJournal' | 'editDocument'
>;

/** Add `markdown` at the end of `source`, as its own paragraph. */
export function appendMarkdown(source: string, markdown: string): string {
  const body = markdown.trim();
  if (!source.trim()) return `${body}\n`;
  return `${source.replace(/\s*$/, '')}\n\n${body}\n`;
}

/** An action that was carried out, and the document it created or changed when there is one to open. */
export interface AppliedAction {
  readonly path: string | null;
  /** For an edit: whether the document's earlier text was kept as a version. */
  readonly versionKept?: boolean;
}

const at = (path: string | null): AppliedAction | null => (path ? { path } : null);

/**
 * Carry out one confirmed action. Creating never replaces anything: a taken
 * name gets a number. An edit keeps a version of the document first and is
 * written only if the document has not changed since it was read. Null when
 * it did not happen (the runner has already said why).
 */
export async function applyProposedAction(
  action: ProposedAction,
  runner: ProposalRunner,
): Promise<AppliedAction | null> {
  switch (action.kind) {
    case 'create-task':
      return at(
        await runner.addDescribedTask({
          title: action.title,
          ...(action.due ? { due: action.due } : {}),
          ...(action.category ? { category: action.category } : {}),
          ...(action.notes ? { notes: action.notes } : {}),
        }),
      );
    case 'create-note':
      return at(await runner.saveNote(action.markdown, action.title));
    case 'add-journal-entry':
      return (await runner.appendToJournal(action.text)) ? { path: null } : null;
    case 'set-properties': {
      const patch = {
        ...(action.due !== undefined ? { due: action.due } : {}),
        ...(action.category !== undefined ? { category: action.category } : {}),
        ...(action.tags !== undefined ? { tags: action.tags.length ? action.tags : null } : {}),
      };
      const changed = await runner.editDocument(
        action.path,
        (source) => applyDocumentProperties(source, patch),
        `change “${action.title}”`,
      );
      return changed ? { path: action.path, versionKept: changed.versionKept } : null;
    }
    case 'append-to-document': {
      const changed = await runner.editDocument(
        action.path,
        (source) => appendMarkdown(source, action.markdown),
        `add to “${action.title}”`,
      );
      return changed ? { path: action.path, versionKept: changed.versionKept } : null;
    }
  }
}
