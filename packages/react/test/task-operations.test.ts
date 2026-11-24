import { expect } from 'chai';
import { MemoryFileSystemProviderV2 } from '@bendyline/docblocks/filesystem/memory';
import { parseWorkspacePath, type FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { resolveTasksFolder } from '@bendyline/docblocks/folders';
import { readDocumentProperties } from '@bendyline/docblocks/properties';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import {
  completeTask,
  createProviderTaskGateway,
  createTask,
  moveTaskToBucket,
  reopenTask,
  setTaskProperties,
  type TaskGateway,
} from '../src/Tasks/task-operations.js';

const p = parseWorkspacePath;
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const TODAY = '2026-11-23';
let sequence = 0;

async function workspace(files: Record<string, string>) {
  const v2 = new MemoryFileSystemProviderV2(`tasks-${++sequence}`, 'Tasks');
  for (const [path, text] of Object.entries(files)) {
    await v2.writeFile(p(path), encode(text), { createParents: true });
  }
  // The gateway only needs `v2` (and `move`, through the shared move helper's v2 path).
  const provider = { v2 } as unknown as FileSystemProvider;
  const gateway = createProviderTaskGateway(provider);
  const read = async (path: string) => {
    const file = await v2.readFile(p(path));
    return file ? decode(file.data) : null;
  };
  const files_ = async () => {
    const paths: string[] = [];
    const walk = async (folder: string) => {
      for (const entry of await v2.readDirectory(p(folder))) {
        if (entry.kind === 'directory') await walk(entry.path);
        else paths.push(entry.path);
      }
    };
    await walk('');
    return paths.sort();
  };
  return { v2, gateway, read, files: files_ };
}

const propertiesOf = (source: string | null) =>
  readDocumentProperties(parseMarkdown(source ?? '').frontmatter);

const folder = resolveTasksFolder(p('Tasks'), {});

describe('task operations', () => {
  it('creates a task in the default bucket, named for what was typed', async () => {
    const ws = await workspace({});
    const path = await createTask(ws.gateway, folder, {
      title: 'Call Sam re: invoice?',
      due: '2026-11-24',
      category: 'Clients',
    });
    expect(path).to.equal('Tasks/Active/Call Sam re invoice.md');
    expect(await ws.read(path)).to.equal('---\ndue: 2026-11-24\ncategory: Clients\n---\n');
    // The same name again gets a number rather than replacing the first.
    const second = await createTask(ws.gateway, folder, { title: 'Call Sam re: invoice?' });
    expect(second).to.equal('Tasks/Active/Call Sam re invoice (2).md');
    expect(await ws.read(second)).to.equal('');
    const loose = await createTask(ws.gateway, folder, { title: '...', bucket: null });
    expect(loose).to.equal('Tasks/Untitled task.md');
  });

  it('finishes a task into Done, keeping its group folders, its attachments and its text', async () => {
    const ws = await workspace({
      'Tasks/Active/House/Paint.md':
        '---\ndue: 2026-11-20\n---\n\n![swatch](Paint_files/swatch.png)\n',
      'Tasks/Active/House/Paint_files/swatch.png': 'png',
    });
    const done = await completeTask(ws.gateway, folder, 'Tasks/Active/House/Paint.md', TODAY);
    expect(done).to.deep.equal({ path: 'Tasks/Done/House/Paint.md', next: null });
    expect(await ws.files()).to.deep.equal([
      'Tasks/Done/House/Paint.md',
      'Tasks/Done/House/Paint_files/swatch.png',
    ]);
    const source = await ws.read(done.path);
    expect(propertiesOf(source)).to.deep.equal({ due: '2026-11-20', completed: TODAY });
    expect(source).to.include('![swatch](Paint_files/swatch.png)');

    const reopened = await reopenTask(ws.gateway, folder, done.path);
    expect(reopened).to.equal('Tasks/Active/House/Paint.md');
    expect(propertiesOf(await ws.read(reopened))).to.deep.equal({ due: '2026-11-20' });
  });

  it('stamps a dated document outside a tasks folder and leaves it where it is', async () => {
    const ws = await workspace({
      'Clients/Acme/Proposal.md': '---\ndue: 2026-11-24\n---\n\n# Proposal\n',
    });
    const done = await completeTask(ws.gateway, null, 'Clients/Acme/Proposal.md', TODAY);
    expect(done.path).to.equal('Clients/Acme/Proposal.md');
    expect(propertiesOf(await ws.read(done.path)).completed).to.equal(TODAY);
    await reopenTask(ws.gateway, null, done.path);
    expect(propertiesOf(await ws.read(done.path)).completed).to.equal(undefined);
  });

  it('moves a finished task beside one of the same name rather than over it', async () => {
    const ws = await workspace({
      'Tasks/Active/Water plants.md': 'new\n',
      'Tasks/Done/Water plants.md': 'old\n',
    });
    const done = await completeTask(ws.gateway, folder, 'Tasks/Active/Water plants.md', TODAY);
    expect(done.path).to.equal('Tasks/Done/Water plants (2).md');
    expect(await ws.read('Tasks/Done/Water plants.md')).to.equal('old\n');
  });

  it('schedules the next one of a repeating task, with its checklist cleared', async () => {
    const ws = await workspace({
      'Tasks/Active/Water plants.md':
        '---\ndue: 2026-11-16\nrepeat: weekly\ncategory: Home\n---\n\n- [x] Fern\n- [X] Basil\n- [ ] Cactus\n',
    });
    const done = await completeTask(ws.gateway, folder, 'Tasks/Active/Water plants.md', TODAY);
    expect(done).to.deep.equal({
      path: 'Tasks/Done/Water plants.md',
      next: 'Tasks/Active/Water plants.md',
      nextDue: '2026-11-30',
    });
    const next = await ws.read(done.next!);
    expect(propertiesOf(next)).to.deep.equal({
      due: '2026-11-30',
      category: 'Home',
      repeat: 'weekly',
    });
    expect(next).to.include('- [ ] Fern\n- [ ] Basil\n- [ ] Cactus');
    expect(propertiesOf(await ws.read(done.path)).completed).to.equal(TODAY);
  });

  it('moves between buckets; into Done finishes, out of Done reopens', async () => {
    const ws = await workspace({ 'Tasks/Active/Book dentist.md': '---\ndue: 2026-11-23\n---\n' });
    const waiting = await moveTaskToBucket(
      ws.gateway,
      folder,
      'Tasks/Active/Book dentist.md',
      'Waiting',
      TODAY,
    );
    expect(waiting).to.equal('Tasks/Waiting/Book dentist.md');
    expect(propertiesOf(await ws.read(waiting)).completed).to.equal(undefined);

    const done = await moveTaskToBucket(ws.gateway, folder, waiting, 'Done', TODAY);
    expect(done).to.equal('Tasks/Done/Book dentist.md');
    expect(propertiesOf(await ws.read(done)).completed).to.equal(TODAY);

    const back = await moveTaskToBucket(ws.gateway, folder, done, 'Someday', TODAY);
    expect(back).to.equal('Tasks/Someday/Book dentist.md');
    expect(propertiesOf(await ws.read(back)).completed).to.equal(undefined);
    expect(await moveTaskToBucket(ws.gateway, folder, back, 'someday', TODAY)).to.equal(back);
  });

  it('changes properties in place and keeps everything else in the file', async () => {
    const ws = await workspace({
      'Tasks/Active/a.md': '---\ntitle: Keep me\ndue: 2026-11-23\n---\n\nBody\n',
    });
    await setTaskProperties(ws.gateway, 'Tasks/Active/a.md', {
      due: '2026-12-01',
      tags: ['x', 'y'],
    });
    const source = await ws.read('Tasks/Active/a.md');
    expect(source).to.include('title: Keep me');
    expect(source!.endsWith('\nBody\n')).to.equal(true);
    expect(propertiesOf(source)).to.deep.equal({ due: '2026-12-01', tags: ['x', 'y'] });
  });

  it('never writes over a change made while it was rewriting, and retries once on its own', async () => {
    const ws = await workspace({ 'a.md': '---\ndue: 2026-11-23\n---\n\nOne\n' });
    let interfered = false;
    const racing: TaskGateway = {
      ...ws.gateway,
      rewrite: (path, transform) =>
        ws.gateway.rewrite(path, async (source) => {
          if (!interfered) {
            interfered = true;
            // A sync client lands a change between our read and our write.
            await ws.v2.writeFile(p('a.md'), encode(`${source}Two\n`));
          }
          return transform(source);
        }),
    };
    await setTaskProperties(racing, 'a.md', { category: 'Home' });
    const source = await ws.read('a.md');
    expect(source).to.include('Two');
    expect(propertiesOf(source).category).to.equal('Home');
  });

  it('refuses to finish a task that is no longer there', async () => {
    const ws = await workspace({});
    let failure: unknown;
    try {
      await completeTask(ws.gateway, folder, 'Tasks/Active/gone.md', TODAY);
    } catch (error: unknown) {
      failure = error;
    }
    expect((failure as Error).message).to.equal('That task is no longer there.');
  });
});
