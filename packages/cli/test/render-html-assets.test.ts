import { expect } from 'chai';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderMarkdownHtml } from '../src/render-html.js';

const MAX_REFERENCED_IMAGES = 100;

describe('CLI referenced-image embedding warns about every drop', () => {
  let tempRoot = '';
  let sourcePath = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-render-assets-'));
    await mkdir(tempRoot, { recursive: true });
    sourcePath = path.join(tempRoot, 'index.md');
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('names the images dropped past the 100-image budget', async () => {
    const total = 120;
    const names = Array.from({ length: total }, (_unused, index) => `image-${index + 1}.png`);
    for (const name of names) await writeFile(path.join(tempRoot, name), name, 'utf-8');
    const markdown = ['# Gallery', '', ...names.map((name) => `![${name}](${name})`)].join('\n\n');
    await writeFile(sourcePath, markdown, 'utf-8');

    const warnings: string[] = [];
    const html = await renderMarkdownHtml(markdown, {
      title: 'Gallery',
      sourcePath,
      assetRoot: tempRoot,
      onWarning: (message) => warnings.push(message),
    });

    // The budget still stands: only the silence was the defect.
    const embedded = names.filter((name) =>
      html.includes(Buffer.from(name).toString('base64')),
    ).length;
    expect(embedded).to.equal(MAX_REFERENCED_IMAGES);

    const report = warnings.join('\n');
    expect(report, 'the drop must be reported').to.contain('Skipped 20 of 120 referenced images');
    expect(report).to.contain('at most 100');
    expect(report).to.contain('image-101.png');
  });

  it('names an image dropped for exceeding the per-image limit', async () => {
    const oversized = Buffer.alloc(21 * 1024 * 1024, 0x61);
    await writeFile(path.join(tempRoot, 'huge.png'), oversized);
    await writeFile(path.join(tempRoot, 'small.png'), 'small', 'utf-8');
    const markdown = '# Assets\n\n![huge](huge.png)\n\n![small](small.png)';
    await writeFile(sourcePath, markdown, 'utf-8');

    const warnings: string[] = [];
    const html = await renderMarkdownHtml(markdown, {
      title: 'Assets',
      sourcePath,
      assetRoot: tempRoot,
      onWarning: (message) => warnings.push(message),
    });

    expect(html).to.contain(Buffer.from('small').toString('base64'));
    const report = warnings.join('\n');
    expect(report).to.contain('huge.png');
    expect(report).to.contain('per-image embed limit');
    expect(report).not.to.contain('small.png');
  });

  it('names an image dropped for exceeding the aggregate budget', async () => {
    await writeFile(path.join(tempRoot, 'first.png'), Buffer.alloc(4_096, 0x61));
    await writeFile(path.join(tempRoot, 'second.png'), Buffer.alloc(4_096, 0x62));
    const markdown = '# Assets\n\n![first](first.png)\n\n![second](second.png)';
    await writeFile(sourcePath, markdown, 'utf-8');

    const warnings: string[] = [];
    await renderMarkdownHtml(markdown, {
      title: 'Assets',
      sourcePath,
      assetRoot: tempRoot,
      maxAssetBytes: 5_000,
      onWarning: (message) => warnings.push(message),
    });

    const report = warnings.join('\n');
    expect(report).to.contain('second.png');
    expect(report).to.contain('total image budget');
  });

  it('stays silent when every referenced image is embedded', async () => {
    await writeFile(path.join(tempRoot, 'diagram.png'), 'diagram', 'utf-8');
    const markdown = '# Assets\n\n![diagram](diagram.png)';
    await writeFile(sourcePath, markdown, 'utf-8');

    const warnings: string[] = [];
    const html = await renderMarkdownHtml(markdown, {
      title: 'Assets',
      sourcePath,
      assetRoot: tempRoot,
      onWarning: (message) => warnings.push(message),
    });

    expect(html).to.contain(Buffer.from('diagram').toString('base64'));
    expect(warnings).to.deep.equal([]);
  });

  it('defaults its warning channel to stderr, never stdout', async () => {
    await writeFile(path.join(tempRoot, 'huge.png'), Buffer.alloc(21 * 1024 * 1024, 0x61));
    const markdown = '# Assets\n\n![huge](huge.png)';
    await writeFile(sourcePath, markdown, 'utf-8');

    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warned.push(args.map((arg) => String(arg)).join(' '));
    };
    try {
      await renderMarkdownHtml(markdown, { title: 'Assets', sourcePath, assetRoot: tempRoot });
    } finally {
      console.warn = originalWarn;
    }

    expect(warned.join('\n')).to.contain('huge.png');
  });
});
