/**
 * Ticking off a task in a workspace that is not open: it is finished on that
 * workspace's storage with its own folder's settings, and the saved digest
 * is amended to match without reading the workspace again.
 */
import { expect } from 'chai';
import { MemoryFileSystemProviderV2 } from '@bendyline/docblocks/filesystem/memory';
import { parseWorkspacePath, type FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { readDocumentProperties } from '@bendyline/docblocks/properties';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { amendDigestAfterToggle, toggleTaskElsewhere } from '../src/Home/elsewhere-tasks.js';
import { HOME_DIGEST_FORMAT, type HomeDigest } from '../src/Home/home-digest.js';
import type { TaskItem } from '../src/Tasks/task-model.js';

const p = parseWorkspacePath;
const TODAY = '2026-11-24';
let sequence = 0;

async function workspace(files: Record<string, string>) {
  const v2 = new MemoryFileSystemProviderV2(`elsewhere-${++sequence}`, 'Elsewhere');
  for (const [path, text] of Object.entries(files)) {
    await v2.writeFile(p(path), new TextEncoder().encode(text), { createParents: true });
  }
  const provider = { v2 } as unknown as FileSystemProvider;
  const read = async (path: string) => {
    const file = await v2.readFile(p(path));
    return file ? new TextDecoder().decode(file.data) : null;
  };
  return { provider, read };
}

const propertiesOf = (source: string | null) =>
  readDocumentProperties(parseMarkdown(source ?? '').frontmatter);

function task(overrides: Partial<TaskItem> & Pick<TaskItem, 'path'>): TaskItem {
  return {
    workspaceId: 'w2',
    title: 'Paint',
    done: false,
    folder: p('Chores'),
    bucket: 'Active',
    group: '',
    pending: false,
    lastModified: '2026-11-20T09:00:00.000Z',
    ...overrides,
  };
}

function digest(items: readonly TaskItem[]): HomeDigest {
  return {
    format: HOME_DIGEST_FORMAT,
    workspaceId: 'w2',
    madeAt: '2026-11-24T08:00:00.000Z',
    folders: [{ path: 'Chores', kind: 'tasks' }],
    items,
    dropped: 0,
  };
}

describe('Ticking off a task in another workspace', () => {
  it('finishes it with its own folder settings, read from that workspace', async () => {
    // This tasks folder calls its done bucket "Finished", which the digest does not know.
    const ws = await workspace({
      'Chores/.docblocks/folder.json':
        '{"version":1,"kind":"tasks","tasks":{"done":["Finished"],"default":"Active"}}',
      'Chores/Active/House/Paint.md': '---\ndue: 2026-11-24\n---\n\nTwo coats.\n',
    });
    const item = task({ path: p('Chores/Active/House/Paint.md'), group: 'House', due: TODAY });
    const change = await toggleTaskElsewhere(ws.provider, item, TODAY);
    expect(change.path).to.equal('Chores/Finished/House/Paint.md');
    expect(change.done).to.equal(true);
    expect(change.next).to.equal(null);
    expect(propertiesOf(await ws.read(change.path)).completed).to.equal(TODAY);
    expect(await ws.read('Chores/Active/House/Paint.md')).to.equal(null);
  });

  it('reopens a finished one into the default bucket', async () => {
    const ws = await workspace({
      'Chores/.docblocks/folder.json': '{"version":1,"kind":"tasks"}',
      'Chores/Done/Paint.md': `---\ncompleted: ${TODAY}\n---\n`,
    });
    const item = task({ path: p('Chores/Done/Paint.md'), bucket: 'Done', done: true });
    const change = await toggleTaskElsewhere(ws.provider, item, TODAY);
    expect(change).to.include({ path: 'Chores/Active/Paint.md', done: false });
    expect(propertiesOf(await ws.read(change.path)).completed).to.equal(undefined);
  });

  it('stamps a task in a folder that is no longer a tasks folder, and leaves it there', async () => {
    const ws = await workspace({ 'Chores/Active/Paint.md': '---\ndue: 2026-11-24\n---\n' });
    const item = task({ path: p('Chores/Active/Paint.md') });
    const change = await toggleTaskElsewhere(ws.provider, item, TODAY);
    expect(change.path).to.equal('Chores/Active/Paint.md');
    expect(change.folder).to.equal(null);
    expect(propertiesOf(await ws.read(change.path)).completed).to.equal(TODAY);
  });

  it('says plainly when the task has gone', async () => {
    const ws = await workspace({ 'Chores/.docblocks/folder.json': '{"version":1,"kind":"tasks"}' });
    let message = '';
    try {
      await toggleTaskElsewhere(ws.provider, task({ path: p('Chores/Active/Paint.md') }), TODAY);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).to.equal('That task is no longer there.');
  });

  it('amends the digest: the task is done where it moved, nothing else changes', async () => {
    const ws = await workspace({
      'Chores/.docblocks/folder.json': '{"version":1,"kind":"tasks"}',
      'Chores/Active/House/Paint.md': '---\ndue: 2026-11-24\n---\n',
    });
    const item = task({ path: p('Chores/Active/House/Paint.md'), group: 'House', due: TODAY });
    const other = task({ path: p('Chores/Active/Rent.md'), title: 'Rent' });
    const change = await toggleTaskElsewhere(ws.provider, item, TODAY);
    const now = new Date('2026-11-24T10:00:00.000Z');
    const amended = amendDigestAfterToggle(digest([item, other]), item, change, TODAY, now);
    expect(amended.madeAt).to.equal('2026-11-24T08:00:00.000Z');
    expect(amended.items).to.have.length(2);
    expect(amended.items).to.deep.include(other);
    expect(amended.items.find((candidate) => candidate.title === 'Paint')).to.deep.equal({
      ...item,
      path: 'Chores/Done/House/Paint.md',
      bucket: 'Done',
      group: 'House',
      done: true,
      completedOn: TODAY,
      lastModified: now.toISOString(),
    });
  });

  it('adds the next occurrence of a repeating task, due again with nothing ticked', async () => {
    const ws = await workspace({
      'Chores/.docblocks/folder.json': '{"version":1,"kind":"tasks"}',
      'Chores/Active/Water plants.md':
        '---\ndue: 2026-11-17\nrepeat: weekly\n---\n\n- [x] Fern\n- [ ] Basil\n',
    });
    const item = task({
      path: p('Chores/Active/Water plants.md'),
      title: 'Water plants',
      due: '2026-11-17',
      repeat: 'weekly',
      checklist: { done: 1, total: 2 },
    });
    const change = await toggleTaskElsewhere(ws.provider, item, TODAY);
    expect(change.next).to.deep.equal({ path: 'Chores/Active/Water plants.md', due: '2026-12-01' });
    const now = new Date('2026-11-24T10:00:00.000Z');
    const amended = amendDigestAfterToggle(digest([item]), item, change, TODAY, now);
    const open = amended.items.filter((candidate) => !candidate.done);
    const done = amended.items.filter((candidate) => candidate.done);
    expect(done.map((candidate) => candidate.path)).to.deep.equal(['Chores/Done/Water plants.md']);
    expect(open).to.have.length(1);
    expect(open[0]).to.include({
      path: 'Chores/Active/Water plants.md',
      due: '2026-12-01',
      bucket: 'Active',
    });
    expect(open[0]!.checklist).to.deep.equal({ done: 0, total: 2 });
    expect(open[0]!.completedOn).to.equal(undefined);
  });
});
