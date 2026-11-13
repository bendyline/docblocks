import { expect } from 'chai';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { zipToContainer } from '@bendyline/squisq-formats/container';
import {
  runExport,
  type ExportBakedMedia,
  type ExportMediaBaker,
} from '../src/Export/run-export.js';
import { DEFAULT_OPTIONS, type ExportOptions } from '../src/Export/export-options.js';

const EDITED_AUDIO =
  '{[audio src=notes_files/audio/take.webm anchor=document clipStart=1 cuts="2-3 6-8" gain=-3]}';
const EDITED_VIDEO =
  '<video src="notes_files/video/screen.webm" controls data-squisq-video-cuts="4-9"></video>';
const PLAIN_AUDIO = '<audio src="notes_files/audio/plain.webm" controls></audio>';
const MARKDOWN = `${EDITED_AUDIO}\n\n# Notes\n\nBody.\n\n${EDITED_VIDEO}\n\n${PLAIN_AUDIO}\n`;

const STORED_AUDIO = 'notes_files/.mediaEdits/take.111111111111.baked.m4a';
const STORED_VIDEO = 'notes_files/.mediaEdits/screen.222222222222.baked.mp4';

/**
 * Stands in for the render manager's baker: rewrites the two edited clips the
 * way `bakeMarkdownMedia` does and records what it was asked for.
 */
function fakeBaker(failVideo = false) {
  const calls: Array<'store' | 'copy'> = [];
  const bakeMedia: ExportMediaBaker = async (markdown, { reference }) => {
    calls.push(reference);
    const audio = reference === 'copy' ? 'notes_files/audio/take-edited.m4a' : STORED_AUDIO;
    const video = reference === 'copy' ? 'notes_files/video/screen-edited.mp4' : STORED_VIDEO;
    let next = markdown.replace(EDITED_AUDIO, `{[audio src=${audio} anchor=document]}`);
    const baked: ExportBakedMedia['baked'][number][] = [{ path: STORED_AUDIO, reference: audio }];
    const failures: ExportBakedMedia['failures'][number][] = [];
    if (failVideo) {
      failures.push({
        src: 'notes_files/video/screen.webm',
        error: 'This browser cannot encode video, so the clip cannot be baked.',
      });
    } else {
      next = next.replace(EDITED_VIDEO, `<video src="${video}" controls></video>`);
      baked.push({ path: STORED_VIDEO, reference: video });
    }
    return { markdown: next, baked, failures };
  };
  return { bakeMedia, calls };
}

async function mediaFolder(): Promise<MemoryContentContainer> {
  const container = new MemoryContentContainer();
  const write = (path: string, size: number) =>
    container.writeFile(path, new Uint8Array(size).fill(size));
  await write('notes_files/audio/take.webm', 10);
  await write('notes_files/video/screen.webm', 20);
  await write('notes_files/audio/plain.webm', 30);
  await write(STORED_AUDIO, 4);
  await write(STORED_VIDEO, 8);
  return container;
}

async function exportHtml(
  options: Partial<ExportOptions>,
  baker: ReturnType<typeof fakeBaker> | null,
  container: MemoryContentContainer | null,
) {
  const saved: Array<{ filename: string; bytes: ArrayBuffer }> = [];
  const result = await runExport(
    MARKDOWN,
    'notes.md',
    { ...DEFAULT_OPTIONS, format: 'html', ...options },
    container,
    async (blob, filename) => {
      saved.push({ filename, bytes: await blob.arrayBuffer() });
    },
    baker ? { bakeMedia: baker.bakeMedia } : {},
  );
  expect(saved).to.have.length(1);
  return { ...saved[0], warnings: result.warnings };
}

const text = (bytes: ArrayBuffer | null | undefined) =>
  new TextDecoder().decode(bytes ?? undefined);

describe('plain Web page export of edited clips', function () {
  this.timeout(30_000);

  it('plays the baked files in a single page, straight from where they are stored', async () => {
    const baker = fakeBaker();
    const page = await exportHtml(
      { htmlStyle: 'plain', htmlBundle: 'single' },
      baker,
      await mediaFolder(),
    );
    expect(baker.calls).to.deep.equal(['store']);
    const html = text(page.bytes);
    expect(html).to.contain(`src="${STORED_AUDIO}"`);
    expect(html).to.contain(`src="${STORED_VIDEO}"`);
    // The edits are in the files now: nothing of the recipe is left to misapply.
    expect(html).not.to.contain('take.webm');
    expect(html).not.to.contain('#t=');
    expect(html).not.to.contain('data-squisq-video-cuts');
    // A clip with no edits is left exactly as it was.
    expect(html).to.contain('src="notes_files/audio/plain.webm"');
    expect(page.warnings).to.deep.equal([]);
  });

  it('carries the baked files in a ZIP under visible names, beside the unedited clips', async () => {
    const baker = fakeBaker();
    const zip = await exportHtml(
      { htmlStyle: 'plain', htmlBundle: 'zip' },
      baker,
      await mediaFolder(),
    );
    expect(baker.calls).to.deep.equal(['copy']);
    expect(zip.filename).to.equal('notes.zip');
    const bundle = await zipToContainer(zip.bytes);
    const html = text(await bundle.readFile('index.html'));
    expect(html).to.contain('src="notes_files/audio/take-edited.m4a"');
    expect(html).to.contain('src="notes_files/video/screen-edited.mp4"');

    // The baked bytes, under the names the page uses — not in the hidden store folder.
    expect((await bundle.readFile('notes_files/audio/take-edited.m4a'))?.byteLength).to.equal(4);
    expect((await bundle.readFile('notes_files/video/screen-edited.mp4'))?.byteLength).to.equal(8);
    expect((await bundle.readFile('notes_files/audio/plain.webm'))?.byteLength).to.equal(30);
    const paths = (await bundle.listFiles()).map((file) => file.path);
    expect(paths.filter((path) => path.includes('.mediaEdits'))).to.deep.equal([]);
    // The originals of the edited clips are not shipped: the page does not play them.
    expect(paths).not.to.include('notes_files/audio/take.webm');
    expect(paths).not.to.include('notes_files/video/screen.webm');
  });

  it('carries the baked files in a linked-pages ZIP too', async () => {
    const baker = fakeBaker();
    const container = await mediaFolder();
    await container.writeDocument(MARKDOWN, 'notes.md');
    const zip = await exportHtml({ htmlStyle: 'plain', includeLinkedDocs: true }, baker, container);
    expect(baker.calls).to.deep.equal(['copy']);
    const bundle = await zipToContainer(zip.bytes);
    const html = text(await bundle.readFile('notes.html'));
    expect(html).to.contain('src="notes_files/audio/take-edited.m4a"');
    expect((await bundle.readFile('notes_files/audio/take-edited.m4a'))?.byteLength).to.equal(4);
    expect((await bundle.readFile('notes_files/video/screen-edited.mp4'))?.byteLength).to.equal(8);
  });

  it('says which clip went out unedited when one cannot be baked', async () => {
    const baker = fakeBaker(true);
    const page = await exportHtml(
      { htmlStyle: 'plain', htmlBundle: 'single' },
      baker,
      await mediaFolder(),
    );
    const html = text(page.bytes);
    expect(html).to.contain(`src="${STORED_AUDIO}"`);
    expect(html).to.contain('src="notes_files/video/screen.webm"');
    expect(page.warnings).to.deep.equal([
      '"screen.webm" was exported without its edits. This browser cannot encode video, so the clip cannot be baked.',
    ]);
  });

  it('leaves a rendered page alone: its player applies the edits itself', async () => {
    const baker = fakeBaker();
    await exportHtml({ htmlStyle: 'rendered', htmlBundle: 'single' }, baker, await mediaFolder());
    expect(baker.calls).to.deep.equal([]);
  });

  it('exports the clips as written when the host has no baker', async () => {
    const page = await exportHtml(
      { htmlStyle: 'plain', htmlBundle: 'single' },
      null,
      await mediaFolder(),
    );
    const html = text(page.bytes);
    expect(html).to.contain('notes_files/audio/take.webm#t=1');
    expect(html).to.contain('src="notes_files/video/screen.webm"');
  });

  it('ships a ZIP of the page with its clips even when it has no images', async () => {
    const zip = await exportHtml(
      { htmlStyle: 'plain', htmlBundle: 'zip' },
      null,
      await mediaFolder(),
    );
    expect(zip.filename).to.equal('notes.zip');
    const bundle = await zipToContainer(zip.bytes);
    // The trim on the audio tag is a `#t=` fragment on the page, not part of the file's name.
    expect((await bundle.readFile('notes_files/audio/take.webm'))?.byteLength).to.equal(10);
    expect((await bundle.readFile('notes_files/video/screen.webm'))?.byteLength).to.equal(20);
    expect((await bundle.readFile('notes_files/audio/plain.webm'))?.byteLength).to.equal(30);
  });
});
