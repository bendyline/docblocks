import { expect } from 'chai';
import { MemoryFileSystemProviderV2 } from '@bendyline/docblocks/filesystem/memory';
import {
  MemoryFileSystemProvider,
  parseWorkspacePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import { workspacePassageUri } from '@bendyline/docblocks/host';
import { readDocumentProperties } from '@bendyline/docblocks/properties';
import { listVersions, readVersion } from '@bendyline/squisq/versions';
import { FileSystemContentContainer } from '@bendyline/docblocks/filesystem';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import {
  ACTION_LIMITS,
  ACTIONS_EDIT_PROMPT,
  actionsRequest,
  appendMarkdown,
  applyProposedAction,
  describeAction,
  parseProposedActions,
  type ActionTarget,
  type ProposedAction,
} from '../src/Ai/chat-actions.js';
import { citedTargets, createProposalStore } from '../src/Ai/ask-proposals.js';
import type { AskTurn } from '../src/Ai/workspace-ask.js';
import { createPageActions } from '../src/Home/page-actions.js';
import { keepDocumentVersion } from '../src/Home/keep-version.js';
import { createProviderTaskGateway } from '../src/Tasks/task-operations.js';

const p = parseWorkspacePath;
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const reply = (actions: unknown[]) => JSON.stringify({ actions });
const targets: ActionTarget[] = [{ path: 'Projects/Garden.md', title: 'Garden' }];
const noEdits = { allowEdits: false, targets };
const withEdits = { allowEdits: true, targets };

describe('Ask suggestions: the request', () => {
  it('asks for structured actions without searching knowledge again', () => {
    const request = actionsRequest({
      question: 'What do I need to do for the garden?',
      answer: 'Buy compost and call the landscaper.',
      facts: 'Today is Monday, 23 November 2026.',
      allowEdits: false,
      targets,
    });
    expect(request.responseFormat?.name).to.equal('docblocks_actions');
    expect(request.searchKnowledge).to.equal(false);
    expect(request.messages[0]!.content).not.to.include(ACTIONS_EDIT_PROMPT);
    expect(request.messages[1]!.content).to.include('Today is Monday');
    // Editable documents are listed only once edits are allowed.
    expect(request.messages[1]!.content).not.to.include('Projects/Garden.md');
  });

  it('offers edits, and names the documents they may touch, only once allowed', () => {
    const request = actionsRequest({
      question: 'q',
      answer: 'a',
      facts: null,
      allowEdits: true,
      targets,
    });
    expect(request.messages[0]!.content).to.include(ACTIONS_EDIT_PROMPT);
    expect(request.messages[1]!.content).to.include('- Projects/Garden.md (Garden)');
    expect(request.messages[1]!.content).not.to.include('Task facts');
  });
});

describe('Ask suggestions: reading the reply', () => {
  it('reads tasks, notes and journal lines, cleaning each field', () => {
    const actions = parseProposedActions(
      reply([
        { type: 'create_task', title: '  Buy   compost ', due: '2026-11-24', category: 'Garden' },
        { type: 'create_note', title: 'Garden plan', markdown: '## Beds\n\n- Tomatoes\n' },
        { type: 'add_journal_entry', text: 'Planned the\ngarden' },
      ]),
      noEdits,
    );
    expect(actions).to.deep.equal([
      { kind: 'create-task', title: 'Buy compost', due: '2026-11-24', category: 'Garden' },
      { kind: 'create-note', title: 'Garden plan', markdown: '## Beds\n\n- Tomatoes' },
      { kind: 'add-journal-entry', text: 'Planned the garden' },
    ]);
  });

  it('finds the JSON inside a fenced block or prose', () => {
    const text = `Here you go:\n\`\`\`json\n${reply([{ type: 'create_task', title: 'Call Priya' }])}\n\`\`\``;
    expect(parseProposedActions(text, noEdits)).to.deep.equal([
      { kind: 'create-task', title: 'Call Priya' },
    ]);
  });

  it('drops what cannot be offered: unknown kinds, missing fields, bad dates, duplicates', () => {
    const actions = parseProposedActions(
      reply([
        { type: 'delete_document', path: 'Projects/Garden.md' },
        { type: 'create_task' },
        { type: 'create_note', title: 'No body' },
        { type: 'create_task', title: 'Water', due: 'next week' },
        { type: 'create_task', title: 'Water', due: 'next week' },
        'not an object',
      ]),
      noEdits,
    );
    // An unreadable due date is left off rather than the task being dropped.
    expect(actions).to.deep.equal([{ kind: 'create-task', title: 'Water' }]);
  });

  it('returns nothing for a reply that holds no action list', () => {
    expect(parseProposedActions('I could not think of anything.', noEdits)).to.deep.equal([]);
    expect(parseProposedActions('{"actions": "none"}', noEdits)).to.deep.equal([]);
    expect(parseProposedActions('{broken', noEdits)).to.deep.equal([]);
  });

  it('never offers an edit unless edits are allowed', () => {
    const edits = [
      { type: 'set_properties', path: 'Projects/Garden.md', due: '2026-12-01' },
      { type: 'append_to_document', path: 'Projects/Garden.md', markdown: 'More.' },
    ];
    expect(parseProposedActions(reply(edits), noEdits)).to.deep.equal([]);
    expect(parseProposedActions(reply(edits), withEdits)).to.deep.equal([
      { kind: 'set-properties', path: 'Projects/Garden.md', title: 'Garden', due: '2026-12-01' },
      {
        kind: 'append-to-document',
        path: 'Projects/Garden.md',
        title: 'Garden',
        markdown: 'More.',
      },
    ]);
  });

  it('only edits documents the answer cited, by their exact path', () => {
    const actions = parseProposedActions(
      reply([
        { type: 'append_to_document', path: 'Private/Diary.md', markdown: 'Hi' },
        { type: 'append_to_document', path: '/Projects/Garden.md', markdown: 'Hi' },
        { type: 'append_to_document', path: 'Projects/../Private/Diary.md', markdown: 'Hi' },
      ]),
      withEdits,
    );
    expect(actions).to.deep.equal([
      { kind: 'append-to-document', path: 'Projects/Garden.md', title: 'Garden', markdown: 'Hi' },
    ]);
  });

  it('reads property changes, and ignores comma tags', () => {
    const [action] = parseProposedActions(
      reply([
        {
          type: 'set_properties',
          path: 'Projects/Garden.md',
          due: '2026-12-01',
          category: 'Home',
          tags: ['outdoor', 'a,b', ' spring '],
        },
      ]),
      withEdits,
    );
    expect(action).to.deep.equal({
      kind: 'set-properties',
      path: 'Projects/Garden.md',
      title: 'Garden',
      due: '2026-12-01',
      category: 'Home',
      tags: ['outdoor', 'spring'],
    });
    expect(describeAction(action!)).to.equal(
      'Change “Garden”: due 2026-12-01, category Home, tags outdoor, spring',
    );
  });

  it('never turns an empty or malformed field into a deletion', () => {
    // Small models fill every field; only the category here is a change.
    const parse = (fields: Record<string, unknown>) =>
      parseProposedActions(
        reply([{ type: 'set_properties', path: 'Projects/Garden.md', ...fields }]),
        withEdits,
      );
    expect(parse({ due: '', category: 'Home', tags: [] })).to.deep.equal([
      { kind: 'set-properties', path: 'Projects/Garden.md', title: 'Garden', category: 'Home' },
    ]);
    expect(parse({ due: 'Friday', category: 'Home' })[0]).to.not.have.property('due');
    expect(parse({ due: '2026-11-31', category: 'Home' })[0]).to.not.have.property('due');
    expect(parse({ due: '', category: '', tags: [''] })).to.deep.equal([]);
  });

  it('a property change with nothing to change is not offered', () => {
    const actions = parseProposedActions(
      reply([{ type: 'set_properties', path: 'Projects/Garden.md' }]),
      withEdits,
    );
    expect(actions).to.deep.equal([]);
  });

  it('caps how many are offered', () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ type: 'create_task', title: `T${n}` }));
    expect(parseProposedActions(reply(many), noEdits)).to.have.length(ACTION_LIMITS.maxActions);
  });
});

describe('Ask suggestions: the documents an edit may target', () => {
  const turnCiting = (paths: string[]): AskTurn =>
    ({
      id: 1,
      question: 'q',
      answer: 'a',
      status: 'done',
      knowledge: {
        outcome: 'used',
        sources: [],
        evidence: paths.map((path, n) => ({
          title: `Doc ${n}`,
          text: 'passage',
          uri: workspacePassageUri('local-workspace', path, 1, 2) ?? undefined,
        })),
      },
    }) as unknown as AskTurn;

  it('are the Markdown documents the answer cited, each once', () => {
    expect(citedTargets(turnCiting(['A.md', 'A.md', 'pic.png', 'B/C.md']))).to.deep.equal([
      { path: 'A.md', title: 'Doc 0' },
      { path: 'B/C.md', title: 'Doc 3' },
    ]);
  });

  it('are only the passages the answer marks, when it marks any', () => {
    const turn = turnCiting(['A.md', 'B/C.md', 'D.md']);
    expect(
      citedTargets({ ...turn, answer: 'Water weekly [2], mulch in spring [3].' }),
    ).to.deep.equal([
      { path: 'B/C.md', title: 'Doc 1' },
      { path: 'D.md', title: 'Doc 2' },
    ]);
  });

  it('never include a passage from a knowledge catalog', () => {
    const turn = turnCiting(['A.md']);
    const evidence = [
      {
        title: 'Aphids',
        text: 'passage',
        catalogId: 'pnw-gardening',
        uri: 'https://example.org/aphids.md',
      },
    ];
    expect(
      citedTargets({ ...turn, knowledge: { ...turn.knowledge!, evidence } } as AskTurn),
    ).to.deep.equal([]);
  });

  it('are none when the answer used no notes', () => {
    expect(
      citedTargets({ ...turnCiting([]), knowledge: null } as unknown as AskTurn),
    ).to.deep.equal([]);
  });
});

describe('Ask suggestions: the conversation state', () => {
  it('keeps proposals per answer, and a reset forgets them and edits allowed', () => {
    const store = createProposalStore();
    store.setAllowEdits(true);
    store.set(1, {
      status: 'ready',
      entries: [
        {
          action: { kind: 'add-journal-entry', text: 'x' },
          state: 'offered',
          path: null,
          versionKept: false,
        },
      ],
    });
    store.updateEntry(1, 0, { state: 'done' });
    const turn = store.getSnapshot().turns.get(1);
    expect(turn?.status === 'ready' && turn.entries[0]!.state).to.equal('done');
    const controller = new AbortController();
    store.set(2, { status: 'thinking', controller });
    store.reset();
    expect(controller.signal.aborted).to.equal(true);
    expect(store.getSnapshot().allowEdits).to.equal(false);
    expect(store.getSnapshot().turns.size).to.equal(0);
  });

  it('starts a card once: never one skipped, done or running, nor an edit without consent', () => {
    const store = createProposalStore();
    const entry = (action: ProposedAction) => ({
      action,
      state: 'offered' as const,
      path: null,
      versionKept: false,
    });
    store.set(1, {
      status: 'ready',
      entries: [
        entry({ kind: 'add-journal-entry', text: 'a' }),
        entry({ kind: 'add-journal-entry', text: 'b' }),
        entry({ kind: 'append-to-document', path: 'G.md', title: 'G', markdown: 'x' }),
      ],
    });
    expect(store.claim(1, 0)).to.deep.equal({ kind: 'add-journal-entry', text: 'a' });
    // A second click, or "Do all" reaching it, finds it already running.
    expect(store.claim(1, 0)).to.equal(null);
    store.updateEntry(1, 1, { state: 'skipped' });
    expect(store.claim(1, 1)).to.equal(null);
    // An edit waits for "Allow edits to cited notes", even if it was offered before.
    expect(store.claim(1, 2)).to.equal(null);
    store.setAllowEdits(true);
    expect(store.claim(1, 2)?.kind).to.equal('append-to-document');
    store.updateEntry(1, 2, { state: 'failed' });
    expect(store.claim(1, 2)?.kind).to.equal('append-to-document');
    expect(store.claim(9, 0)).to.equal(null);
  });
});

describe('Ask suggestions: carrying them out', () => {
  let sequence = 0;

  async function setUp(files: Record<string, string> = {}, keepVersion?: () => Promise<void>) {
    const v2 = new MemoryFileSystemProviderV2(`chat-${++sequence}`, 'Chat');
    for (const [path, text] of Object.entries(files)) {
      await v2.writeFile(p(path), encode(text), { createParents: true });
    }
    const reports: string[] = [];
    const kept: { path: string; source: string }[] = [];
    const actions = createPageActions({
      gateway: createProviderTaskGateway({ v2 } as unknown as FileSystemProvider),
      storage: v2,
      kindFolders: () => [],
      documentPaths: () => [],
      today: () => '2026-11-23',
      now: () => new Date(2026, 10, 23, 9, 5),
      confirmDelete: async () => true,
      report: (kind, message) => reports.push(`${kind}: ${message}`),
      changed: () => undefined,
      openDocument: () => undefined,
      openFolder: () => undefined,
      keepVersion: async (path, source) => {
        await keepVersion?.();
        kept.push({ path, source });
      },
    });
    const read = async (path: string) => {
      const file = await v2.readFile(p(path));
      return file ? decode(file.data) : null;
    };
    return { v2, actions, reports, kept, read };
  }

  it('creates a task in the tasks folder with its due date and category', async () => {
    const { actions, read } = await setUp();
    const applied = await applyProposedAction(
      { kind: 'create-task', title: 'Buy compost', due: '2026-11-24', category: 'Garden' },
      actions,
    );
    expect(applied?.path).to.equal('Tasks/Active/Buy compost.md');
    const source = (await read('Tasks/Active/Buy compost.md'))!;
    expect(readDocumentProperties(parseMarkdown(source).frontmatter ?? {})).to.deep.include({
      due: '2026-11-24',
      category: 'Garden',
    });
  });

  it('never replaces a document: a note with a taken name gets a number', async () => {
    const { actions, read } = await setUp({
      'Unfiled/.docblocks/folder.json': '{"version":1,"kind":"unfiled"}',
      'Unfiled/Garden plan.md': 'Mine.\n',
    });
    const applied = await applyProposedAction(
      { kind: 'create-note', title: 'Garden plan', markdown: '## Beds' },
      actions,
    );
    expect(applied?.path).to.equal('Unfiled/Garden plan (2).md');
    expect(await read('Unfiled/Garden plan.md')).to.equal('Mine.\n');
    expect(await read('Unfiled/Garden plan (2).md')).to.equal('## Beds\n');
  });

  it("adds a line to today's journal entry, with nothing to open", async () => {
    const { actions, read } = await setUp();
    const applied = await applyProposedAction(
      { kind: 'add-journal-entry', text: 'Planned the garden' },
      actions,
    );
    expect(applied).to.deep.equal({ path: null });
    expect(await read('Journal/2026/2026-11-23.md')).to.include('- 09:05 Planned the garden');
  });

  it('keeps a version of a document before changing its properties', async () => {
    const before = '# Garden\n\nBeds.\n';
    const { actions, kept, read } = await setUp({ 'Projects/Garden.md': before });
    const applied = await applyProposedAction(
      {
        kind: 'set-properties',
        path: 'Projects/Garden.md',
        title: 'Garden',
        due: '2026-12-01',
        tags: ['outdoor'],
      },
      actions,
    );
    expect(applied).to.deep.equal({ path: 'Projects/Garden.md', versionKept: true });
    expect(kept).to.deep.equal([{ path: 'Projects/Garden.md', source: before }]);
    const after = (await read('Projects/Garden.md'))!;
    expect(readDocumentProperties(parseMarkdown(after).frontmatter ?? {})).to.deep.include({
      due: '2026-12-01',
      tags: ['outdoor'],
    });
    expect(after).to.include('Beds.');
  });

  it('adds to the end of a document as its own paragraph', async () => {
    const { actions, read } = await setUp({ 'Projects/Garden.md': '# Garden\n\nBeds.' });
    await applyProposedAction(
      {
        kind: 'append-to-document',
        path: 'Projects/Garden.md',
        title: 'Garden',
        markdown: '- Compost',
      },
      actions,
    );
    expect(await read('Projects/Garden.md')).to.equal('# Garden\n\nBeds.\n\n- Compost\n');
  });

  it('does not edit when the version could not be kept', async () => {
    const { actions, reports, read } = await setUp({ 'Projects/Garden.md': 'Beds.\n' }, () =>
      Promise.reject(new Error('The disk is full.')),
    );
    const applied = await applyProposedAction(
      { kind: 'append-to-document', path: 'Projects/Garden.md', title: 'Garden', markdown: 'X' },
      actions,
    );
    expect(applied).to.equal(null);
    expect(await read('Projects/Garden.md')).to.equal('Beds.\n');
    expect(reports).to.deep.equal(["error: Couldn't add to “Garden”. The disk is full."]);
  });

  it('reports a document that is gone instead of creating it', async () => {
    const { actions, reports, read } = await setUp();
    const applied = await applyProposedAction(
      { kind: 'append-to-document', path: 'Projects/Garden.md', title: 'Garden', markdown: 'X' },
      actions,
    );
    expect(applied).to.equal(null);
    expect(await read('Projects/Garden.md')).to.equal(null);
    expect(reports).to.have.length(1);
  });
});

describe('Ask suggestions: appending Markdown', () => {
  it('separates the addition from what is there by one blank line', () => {
    expect(appendMarkdown('A\n\n\n', 'B')).to.equal('A\n\nB\n');
    expect(appendMarkdown('', '  B  ')).to.equal('B\n');
  });
});

describe('Keeping a version before an edit', () => {
  it("writes it to the document's companion folder, where the editor lists versions", async () => {
    const provider = new MemoryFileSystemProvider('versions', 'Versions');
    await provider.writeFile('/Projects/Garden.md', encode('Beds.\n'));
    await keepDocumentVersion(provider, 'Projects/Garden.md', 'Beds.\n', new Date(2026, 10, 23));
    const container = new FileSystemContentContainer(provider, 'Projects/Garden_files', {
      documentMediaPrefix: 'Garden_files',
    });
    const versions = await listVersions(container, 'Garden');
    expect(versions).to.have.length(1);
    expect(await readVersion(container, versions[0]!)).to.equal('Beds.\n');
  });
});
