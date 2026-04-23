/**
 * Happy-path tests for forward-direction MCP tools:
 *   - export_markdown_to_{docx,pdf,pptx,html}
 *   - analyze_markdown, restyle_markdown
 *   - list_themes, list_transform_styles, list_export_formats
 *
 * `export_markdown_to_video` is intentionally skipped — it requires ffmpeg
 * and Playwright and is too heavy for unit tests.
 *
 * Validation strategy per export format: check magic bytes and, for ZIP
 * containers, check that the format-specific marker part is present.
 */

import { expect } from 'chai';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { startMcpHarness, callTool, SAMPLE_MARKDOWN, type McpHarness } from './mcp-helpers.js';

describe('MCP forward-direction tools', function () {
  this.timeout(60_000);

  let h: McpHarness;

  before(async () => {
    h = await startMcpHarness();
  });

  after(async () => {
    await h.dispose();
  });

  describe('export_markdown_to_docx', () => {
    it('produces a valid DOCX file', async () => {
      const outPath = join(h.tmpDir, 'out.docx');
      const { text, isError } = await callTool(h.client, 'export_markdown_to_docx', {
        markdown: SAMPLE_MARKDOWN,
        outputPath: outPath,
      });
      expect(isError).to.equal(false);
      const payload = JSON.parse(text);
      expect(payload.format).to.equal('docx');
      expect(payload.fileSize).to.be.greaterThan(0);
      const buf = await readFile(outPath);
      // DOCX = ZIP archive; zip local file header magic = "PK\x03\x04"
      expect(buf.subarray(0, 4).toString('hex')).to.equal('504b0304');
      const zip = await JSZip.loadAsync(buf);
      expect(zip.file('word/document.xml')).to.not.equal(null);
    });
  });

  describe('export_markdown_to_pptx', () => {
    it('produces a valid PPTX file with at least one slide', async () => {
      const outPath = join(h.tmpDir, 'out.pptx');
      const { isError } = await callTool(h.client, 'export_markdown_to_pptx', {
        markdown: SAMPLE_MARKDOWN,
        outputPath: outPath,
      });
      expect(isError).to.equal(false);
      const buf = await readFile(outPath);
      expect(buf.subarray(0, 4).toString('hex')).to.equal('504b0304');
      const zip = await JSZip.loadAsync(buf);
      expect(zip.file('ppt/presentation.xml')).to.not.equal(null);
      const slideNames = Object.keys(zip.files).filter((n) =>
        /^ppt\/slides\/slide\d+\.xml$/.test(n),
      );
      expect(slideNames.length).to.be.greaterThan(0);
    });
  });

  describe('export_markdown_to_pdf', () => {
    it('produces a file starting with %PDF-', async () => {
      const outPath = join(h.tmpDir, 'out.pdf');
      const { isError } = await callTool(h.client, 'export_markdown_to_pdf', {
        markdown: SAMPLE_MARKDOWN,
        outputPath: outPath,
      });
      expect(isError).to.equal(false);
      const buf = await readFile(outPath);
      expect(buf.subarray(0, 5).toString('ascii')).to.equal('%PDF-');
      const info = await stat(outPath);
      expect(info.size).to.be.greaterThan(0);
    });
  });

  describe('export_markdown_to_html', () => {
    it('produces self-contained HTML with the embedded player script', async () => {
      const outPath = join(h.tmpDir, 'out.html');
      const { isError } = await callTool(h.client, 'export_markdown_to_html', {
        markdown: SAMPLE_MARKDOWN,
        outputPath: outPath,
      });
      expect(isError).to.equal(false);
      const html = await readFile(outPath, 'utf-8');
      expect(html.toLowerCase()).to.include('<!doctype html');
      expect(html).to.include('</html>');
      expect(html).to.match(/<script\b/i);
    });
  });

  describe('analyze_markdown', () => {
    it('returns structural stats and extracted content', async () => {
      const { text, isError } = await callTool(h.client, 'analyze_markdown', {
        markdown: SAMPLE_MARKDOWN,
      });
      expect(isError).to.equal(false);
      const payload = JSON.parse(text);
      expect(payload.stats.headingCount).to.be.greaterThan(0);
      expect(payload.stats.wordCount).to.be.greaterThan(0);
      expect(payload.extracted).to.be.an('object');
    });
  });

  describe('restyle_markdown', () => {
    it('returns transformed markdown for a known transform style', async () => {
      // First discover a valid style so the test survives style rename.
      const listed = await callTool(h.client, 'list_transform_styles', {});
      const styles = JSON.parse(listed.text) as Array<{ id: string }>;
      expect(styles.length).to.be.greaterThan(0);
      const style = styles[0].id;

      const { text, isError } = await callTool(h.client, 'restyle_markdown', {
        markdown: SAMPLE_MARKDOWN,
        style,
      });
      expect(isError).to.equal(false);
      expect(text).to.be.a('string');
      expect(text.length).to.be.greaterThan(0);
    });

    it('reports error for an unknown transform style', async () => {
      const { isError, text } = await callTool(h.client, 'restyle_markdown', {
        markdown: SAMPLE_MARKDOWN,
        style: 'definitely-not-a-real-style-123',
      });
      expect(isError).to.equal(true);
      expect(text.toLowerCase()).to.include('unknown transform style');
    });
  });

  describe('list_themes', () => {
    it('returns an array of themes', async () => {
      const { text, isError } = await callTool(h.client, 'list_themes', {});
      expect(isError).to.equal(false);
      const themes = JSON.parse(text);
      expect(themes).to.be.an('array').with.length.greaterThan(0);
    });
  });

  describe('list_transform_styles', () => {
    it('returns an array of transform styles', async () => {
      const { text, isError } = await callTool(h.client, 'list_transform_styles', {});
      expect(isError).to.equal(false);
      const styles = JSON.parse(text);
      expect(styles).to.be.an('array').with.length.greaterThan(0);
    });
  });

  describe('list_export_formats', () => {
    it('lists both input and output formats including reverse-conversion tools', async () => {
      const { text, isError } = await callTool(h.client, 'list_export_formats', {});
      expect(isError).to.equal(false);
      const formats = JSON.parse(text);
      expect(formats.input).to.be.an('array');
      expect(formats.output).to.be.an('array');
      const outputFormats = (formats.output as Array<{ format: string }>).map((f) => f.format);
      expect(outputFormats).to.include.members(['docx', 'pdf', 'pptx', 'html']);
      const inputExts = (formats.input as Array<{ ext: string }>).map((f) => f.ext);
      expect(inputExts).to.include.members(['.docx', '.pptx', '.pdf']);
    });
  });
});
