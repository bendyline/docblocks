import { expect } from 'chai';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { ConversionError, createCliRegistry } from '@bendyline/squisq-cli/api';
import { docxToContainer } from '@bendyline/squisq-formats/docx';
import { publishConversionBatch, runConvert } from '../src/commands/convert.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);

describe('CLI registry-backed conversion', function () {
  this.timeout(30_000);

  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-convert-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('preserves DBK container media when exporting DOCX', async () => {
    const archive = new JSZip();
    archive.file('index.md', '# Media\n\n![Pixel](media/pixel.png)\n');
    archive.file('media/pixel.png', TINY_PNG);
    const inputPath = path.join(tempRoot, 'media.dbk');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, await archive.generateAsync({ type: 'nodebuffer' }));

    const result = await runConvert(inputPath, { outputDir, formats: 'docx' });

    expect(result.outputFiles).to.have.length(1);
    expect(result.outputFiles[0]).to.include({
      format: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      suggestedFilename: 'media.docx',
    });

    const docxBytes = await readFile(result.outputFiles[0].path);
    const imported = await docxToContainer(
      docxBytes.buffer.slice(
        docxBytes.byteOffset,
        docxBytes.byteOffset + docxBytes.byteLength,
      ) as ArrayBuffer,
    );
    const imageEntries = (await imported.listFiles()).filter((entry) =>
      /\.(?:png|jpe?g|gif|webp)$/i.test(entry.path),
    );
    expect(imageEntries).to.have.length.greaterThan(0);
    const restored = await Promise.all(
      imageEntries.map(async (entry) => new Uint8Array((await imported.readFile(entry.path)) ?? 0)),
    );
    expect(restored.some((bytes) => Buffer.from(bytes).equals(TINY_PNG))).to.equal(true);
  });

  it('accepts explicit linked-registry formats and returns conversion warnings', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(
      inputPath,
      ['# Tables', '', '| First |', '| --- |', '| A |', '', '| Second |', '| --- |', '| B |'].join(
        '\n',
      ),
      'utf8',
    );

    const result = await runConvert(inputPath, { outputDir, formats: 'csv' });
    const output = result.outputFiles[0];

    expect(output).to.include({
      format: 'csv',
      mimeType: 'text/csv',
      suggestedFilename: 'tables.csv',
    });
    expect(output.warnings.some((warning) => warning.includes('2 tables'))).to.equal(true);
    expect(await readFile(output.path, 'utf8')).to.include('First');
  });

  it('keeps an existing output intact when a conversion exceeds its budget', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    const outputPath = path.join(outputDir, 'tables.csv');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');
    await mkdir(outputDir);
    await writeFile(outputPath, 'previous output', 'utf8');

    let caught: unknown;
    try {
      // Overwrite is allowed so the run reaches the budget check under test
      // rather than stopping at the destination-conflict preflight.
      await runConvert(inputPath, {
        outputDir,
        formats: 'csv',
        maxOutputBytes: 1,
        allowOverwrite: true,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('output exceeds');
    expect(await readFile(outputPath, 'utf8')).to.equal('previous output');
    expect(await readdir(outputDir)).to.deep.equal(['tables.csv']);
  });

  it('leaves no partial batch and preserves overwritten files when a later converter fails', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    const csvPath = path.join(outputDir, 'tables.csv');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');
    await mkdir(outputDir);
    await writeFile(csvPath, 'ORIGINAL USER CONTENT', 'utf8');

    const registry = createCliRegistry();
    const html = registry.get('html');
    if (!html?.exportDoc) throw new Error('Expected the linked HTML exporter');
    registry.register({
      ...html,
      exportDoc: async () => {
        throw new Error('intentional later-target failure');
      },
    });

    let caught: unknown;
    try {
      await runConvert(inputPath, {
        outputDir,
        formats: 'csv,html',
        allowOverwrite: true,
        registry,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('intentional later-target failure');
    expect(await readFile(csvPath, 'utf8')).to.equal('ORIGINAL USER CONTENT');
    expect(await readdir(outputDir)).to.deep.equal(['tables.csv']);
  });

  it('rolls back committed replacements when a later publication step fails', async () => {
    const outputDir = path.join(tempRoot, 'out');
    const firstPath = path.join(outputDir, 'first.txt');
    const secondPath = path.join(outputDir, 'second.txt');
    await mkdir(outputDir);
    await writeFile(firstPath, 'original first', 'utf8');
    await writeFile(secondPath, 'original second', 'utf8');

    let caught: unknown;
    try {
      await publishConversionBatch(
        [
          { path: firstPath, bytes: Buffer.from('replacement first') },
          { path: secondPath, bytes: Buffer.from('replacement second') },
        ],
        outputDir,
        true,
        undefined,
        (publishedCount) => {
          if (publishedCount === 1) throw new Error('intentional commit fault');
        },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('intentional commit fault');
    expect(await readFile(firstPath, 'utf8')).to.equal('original first');
    expect(await readFile(secondPath, 'utf8')).to.equal('original second');
    expect(await readdir(outputDir)).to.deep.equal(['first.txt', 'second.txt']);
  });

  it('atomically replaces an existing converter-named output without leaving staging files', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    const outputPath = path.join(outputDir, 'tables.csv');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');
    await mkdir(outputDir);
    await writeFile(outputPath, 'previous output', 'utf8');

    await runConvert(inputPath, { outputDir, formats: 'csv', allowOverwrite: true });

    expect(await readFile(outputPath, 'utf8')).to.include('A');
    expect(await readdir(outputDir)).to.deep.equal(['tables.csv']);
  });

  it('refuses to overwrite an existing output and names it without converting', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    const outputPath = path.join(outputDir, 'tables.csv');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');
    await mkdir(outputDir);
    await writeFile(outputPath, 'previous output', 'utf8');

    let caught: unknown;
    try {
      await runConvert(inputPath, { outputDir, formats: 'csv' });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    const message = (caught as Error).message;
    expect(message).to.include('Refusing to overwrite');
    expect(message).to.include(outputPath);
    expect(message).to.include('--allow-overwrite');
    expect(await readFile(outputPath, 'utf8')).to.equal('previous output');
    expect(await readdir(outputDir)).to.deep.equal(['tables.csv']);
  });

  it('writes normally when no destination conflicts exist', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');

    const result = await runConvert(inputPath, { outputDir, formats: 'csv' });

    expect(result.outputFiles).to.have.length(1);
    expect(await readFile(result.outputFiles[0].path, 'utf8')).to.include('A');
    expect(await readdir(outputDir)).to.deep.equal(['tables.csv']);
  });

  it('aborts the whole multi-format run when a single destination conflicts', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');
    await mkdir(outputDir);
    await writeFile(path.join(outputDir, 'tables.html'), 'hand-authored', 'utf8');

    let caught: unknown;
    try {
      await runConvert(inputPath, { outputDir, formats: 'csv,html' });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('tables.html');
    // The clean csv destination must not be written either: one conflict
    // refuses the run rather than producing a partial export.
    expect(await readFile(path.join(outputDir, 'tables.html'), 'utf8')).to.equal('hand-authored');
    expect(await readdir(outputDir)).to.deep.equal(['tables.html']);
  });

  it('reports every conflicting destination in one refusal', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');
    await mkdir(outputDir);
    await writeFile(path.join(outputDir, 'tables.csv'), 'existing csv', 'utf8');
    await writeFile(path.join(outputDir, 'tables.html'), 'existing html', 'utf8');

    let caught: unknown;
    try {
      await runConvert(inputPath, { outputDir, formats: 'csv,html' });
    } catch (error: unknown) {
      caught = error;
    }

    const message = (caught as Error).message;
    expect(message).to.include('2 existing files');
    expect(message).to.include(path.join(outputDir, 'tables.csv'));
    expect(message).to.include(path.join(outputDir, 'tables.html'));
  });

  it('replaces every conflicting destination when overwrite is allowed', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');
    await mkdir(outputDir);
    await writeFile(path.join(outputDir, 'tables.csv'), 'existing csv', 'utf8');

    const result = await runConvert(inputPath, {
      outputDir,
      formats: 'csv,html',
      allowOverwrite: true,
    });

    expect(result.outputFiles).to.have.length(2);
    expect(await readFile(path.join(outputDir, 'tables.csv'), 'utf8')).to.include('A');
    expect(await readdir(outputDir)).to.deep.equal(['tables.csv', 'tables.html']);
  });

  it('rejects an input that exceeds the conversion budget before importing it', async () => {
    const inputPath = path.join(tempRoot, 'input.md');
    await writeFile(inputPath, '# Input', 'utf8');
    let caught: unknown;
    try {
      await runConvert(inputPath, { formats: 'csv', maxInputBytes: 1 });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('input exceeds');
  });

  it('reports a missing input without exposing a raw ENOENT', async () => {
    let caught: unknown;
    try {
      await runConvert(path.join(tempRoot, 'missing.md'), { formats: 'html' });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('Conversion input not found:');
    expect((caught as Error).message).not.to.include('ENOENT');
  });

  it('refuses a duplicated requested format instead of converting it twice', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');

    let caught: unknown;
    try {
      await runConvert(inputPath, { outputDir, formats: 'csv,csv' });
    } catch (error: unknown) {
      caught = error;
    }

    // The MCP conversion service already refuses duplicate targets; the CLI
    // used to convert and publish the same destination twice.
    expect(caught).to.be.instanceOf(ConversionError);
    expect((caught as Error).message).to.include('Duplicate conversion target: csv');
    expect(await readdir(outputDir).catch(() => [])).to.deep.equal([]);
  });

  it('treats a repeated format as duplicate regardless of spacing or case', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');

    let caught: unknown;
    try {
      await runConvert(inputPath, { outputDir: path.join(tempRoot, 'out'), formats: 'csv, CSV' });
    } catch (error: unknown) {
      caught = error;
    }
    expect((caught as Error).message).to.include('Duplicate conversion target: csv');
  });

  it('fails the run when an explicitly requested format is skipped', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');

    let caught: unknown;
    try {
      // A typo'd format used to warn on stderr, produce no output for it, and
      // still exit 0 — invisible in CI.
      await runConvert(inputPath, { outputDir, formats: 'csv,tiff' });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(ConversionError);
    const conversionError = caught as ConversionError;
    expect(conversionError.message).to.include('tiff');
    expect(conversionError).to.include({ code: 'unknown-format', format: 'tiff' });
    // All-or-nothing: the valid csv target must not be written either.
    expect(await readdir(outputDir).catch(() => [])).to.deep.equal([]);
  });

  it('names every unknown requested format in one refusal', async () => {
    const inputPath = path.join(tempRoot, 'tables.md');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');

    let caught: unknown;
    try {
      await runConvert(inputPath, { formats: 'tiff,bmp' });
    } catch (error: unknown) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).to.include('tiff, bmp');
    expect(message).to.include('Valid:');
  });

  it('still skips an unexportable format from the built-in default set', async () => {
    // The default set is DocBlocks' own choice rather than the caller's, so
    // registry drift degrades to a warning instead of breaking a bare
    // `docblocks convert`. Only an explicit --formats entry is a hard error.
    const inputPath = path.join(tempRoot, 'tables.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, '# Tables\n\n| A |\n| - |\n| B |', 'utf8');

    const registry = createCliRegistry();
    const html = registry.get('html');
    if (!html?.exportDoc) throw new Error('Expected the linked HTML exporter');
    // `html` is in the default set; docx/pptx/pdf/dbk are not exportable here.
    const narrowed = {
      list: () => [html],
      get: (id: string) => (id === 'html' ? html : undefined),
      register: () => undefined,
    } as unknown as ReturnType<typeof createCliRegistry>;

    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warned.push(args.map((arg) => String(arg)).join(' '));
    };
    let result;
    try {
      // No --formats: the default set is used and drift is tolerated.
      result = await runConvert(inputPath, { outputDir, registry: narrowed });
    } finally {
      console.warn = originalWarn;
    }

    expect(result.outputFiles.map((file) => file.format)).to.deep.equal(['html']);
    expect(warned.join('\n')).to.include('default format');
  });

  it('preserves stable ConversionError metadata for unsupported format requests', async () => {
    const inputPath = path.join(tempRoot, 'input.md');
    await writeFile(inputPath, '# Input', 'utf8');

    let caught: unknown;
    try {
      await runConvert(inputPath, { formats: 'not-a-format' });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(ConversionError);
    const conversionError = caught as ConversionError;
    expect(conversionError).to.include({
      code: 'unknown-format',
      format: 'not-a-format',
    });
    expect(conversionError.hint).to.include('linked Squisq CLI registry');
  });

  it('rejects an unknown theme before creating conversion output', async () => {
    const inputPath = path.join(tempRoot, 'input.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, '# Input', 'utf8');

    let caught: unknown;
    try {
      await runConvert(inputPath, {
        formats: 'html',
        outputDir,
        theme: 'not-a-real-theme',
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('Unknown theme "not-a-real-theme"');
    expect(await readdir(outputDir).catch(() => [])).to.deep.equal([]);
  });

  it('passes the caller signal into the linked registry and preserves its abort reason', async () => {
    const inputPath = path.join(tempRoot, 'input.md');
    const outputDir = path.join(tempRoot, 'out');
    await writeFile(inputPath, '# Input', 'utf8');
    const registry = createCliRegistry();
    const csv = registry.get('csv');
    if (!csv?.exportDoc) throw new Error('Expected the linked CSV exporter');
    const originalExport = csv.exportDoc;
    const controller = new AbortController();
    const reason = new Error('cancelled inside linked exporter');
    let receivedSignal: AbortSignal | undefined;
    registry.register({
      ...csv,
      exportDoc: async (input, options) => {
        receivedSignal = options.signal;
        const result = await originalExport(input, options);
        controller.abort(reason);
        return result;
      },
    });

    let caught: unknown;
    try {
      await runConvert(inputPath, {
        outputDir,
        formats: 'csv',
        registry,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(receivedSignal).to.equal(controller.signal);
    expect(caught).to.equal(reason);
    expect(await readdir(outputDir).catch(() => [])).to.deep.equal([]);
  });
});
