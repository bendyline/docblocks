import { expect } from 'chai';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { ConversionError, createCliRegistry } from '@bendyline/squisq-cli/api';
import { docxToContainer } from '@bendyline/squisq-formats/docx';
import { runConvert } from '../src/commands/convert.js';

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
    expect(await readdir(outputDir)).to.deep.equal([]);
  });
});
