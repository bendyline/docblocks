import { expect } from 'chai';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DASHBOARD_STYLE_IDS } from '@bendyline/squisq/doc';
import { DASHBOARD_RESOLUTIONS, DEFAULT_DASHBOARD_RESOLUTION } from '@bendyline/squisq-video';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import {
  assertKnownDashboardLayout,
  hasDashboardImageInput,
  resolveDashboardImageOptions,
} from '../src/internal/dashboard-image.js';
import { runConvert } from '../src/commands/convert.js';
import { convertCommand } from '../src/commands/convert.js';
import {
  MCP_DASHBOARD_RESOLUTION_IDS,
  MCP_DASHBOARD_STYLE_IDS,
  MCP_FORMAT_FIDELITIES,
} from '../src/mcp/conversion-service.js';
import { MCP_CONVERSION_TARGET_FORMATS } from '../src/mcp/server.js';

describe('dashboard image conversion controls', () => {
  describe('option resolution', () => {
    it('defers every axis to the document when nothing is requested', async () => {
      const input = {};
      expect(hasDashboardImageInput(input)).to.equal(false);
      expect(await resolveDashboardImageOptions(input)).to.deep.equal({});
    });

    it('detects any single supplied axis', () => {
      expect(hasDashboardImageInput({ style: 'card' })).to.equal(true);
      expect(hasDashboardImageInput({ title: false })).to.equal(true);
      expect(hasDashboardImageInput({ width: 800 })).to.equal(true);
    });

    it('carries a named resolution preset through untouched', async () => {
      expect(await resolveDashboardImageOptions({ resolution: 'square' })).to.deep.equal({
        resolution: 'square',
      });
    });

    it('accepts custom dimensions supplied as Commander strings', async () => {
      expect(await resolveDashboardImageOptions({ width: '2400', height: '1350' })).to.deep.equal({
        width: 2400,
        height: 1350,
      });
    });

    it('rejects an unknown resolution preset before any render begins', async () => {
      await expectRejection(
        resolveDashboardImageOptions({ resolution: 'ultrawide' }),
        'Unknown resolution preset',
      );
    });

    it('rejects a preset combined with custom pixels as contradictory', async () => {
      await expectRejection(
        resolveDashboardImageOptions({ resolution: 'fhd', width: 800, height: 600 }),
        'not both',
      );
    });

    it('requires both custom dimensions together', async () => {
      await expectRejection(
        resolveDashboardImageOptions({ width: 800 }),
        'require both width and height',
      );
    });

    it('enforces the shared Squisq dimension ceiling', async () => {
      await expectRejection(
        resolveDashboardImageOptions({ width: 9_000, height: 900 }),
        'at most 7680 pixels',
      );
      await expectRejection(
        resolveDashboardImageOptions({ width: 32, height: 32 }),
        'at least 64 pixels',
      );
    });

    it('rejects a non-numeric pixel count', async () => {
      await expectRejection(
        resolveDashboardImageOptions({ width: 'wide', height: '600' }),
        'whole number of pixels',
      );
    });

    it('normalizes every style spelling Squisq accepts', async () => {
      expect(await resolveDashboardImageOptions({ style: 'Cards' })).to.deep.equal({
        style: 'card',
      });
      expect(await resolveDashboardImageOptions({ style: 'outline' })).to.deep.equal({
        style: 'panel',
      });
      for (const style of DASHBOARD_STYLE_IDS) {
        expect(await resolveDashboardImageOptions({ style })).to.deep.equal({ style });
      }
    });

    it('rejects a style outside the closed vocabulary', async () => {
      await expectRejection(
        resolveDashboardImageOptions({ style: 'neon' }),
        'Unknown dashboard style "neon"',
      );
    });

    it('normalizes the layout id but leaves validity to the document', async () => {
      expect(await resolveDashboardImageOptions({ layout: '  Hero-Split ' })).to.deep.equal({
        layout: 'hero-split',
      });
      await expectRejection(
        resolveDashboardImageOptions({ layout: '   ' }),
        'must be a non-empty string',
      );
    });

    it('keeps the title band tri-state so an unset flag defers to frontmatter', async () => {
      expect(await resolveDashboardImageOptions({ title: false })).to.deep.equal({ title: false });
      expect(await resolveDashboardImageOptions({ title: true })).to.deep.equal({ title: true });
      expect(await resolveDashboardImageOptions({})).to.not.have.property('title');
    });
  });

  describe('layout validation against the document', () => {
    it('accepts auto and every built-in layout', async () => {
      const doc = await docFor('# Layouts\n\nOne block.\n');
      await assertKnownDashboardLayout('auto', doc);
      await assertKnownDashboardLayout(undefined, doc);
    });

    it('rejects a layout the document cannot use, naming the valid ids', async () => {
      const doc = await docFor('# Layouts\n\nOne block.\n');
      await expectRejection(
        assertKnownDashboardLayout('not-a-layout', doc),
        'Unknown dashboard layout "not-a-layout"',
      );
    });
  });

  describe('convert command wiring', () => {
    let tempRoot = '';

    beforeEach(async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-dashboard-'));
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('exposes an --image-* flag for each dashboard axis', () => {
      const flags = convertCommand.options.map((option) => option.long);
      expect(flags).to.include.members([
        '--image-resolution',
        '--image-width',
        '--image-height',
        '--image-layout',
        '--image-style',
        '--image-title',
        '--no-image-title',
      ]);
    });

    it('refuses --image-* options when png is not a requested target', async () => {
      const inputPath = path.join(tempRoot, 'brief.md');
      await writeFile(inputPath, '# Brief\n\nOne block.\n');

      let caught: unknown;
      try {
        await runConvert(inputPath, {
          outputDir: tempRoot,
          formats: 'md',
          imageStyle: 'card',
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(String(caught)).to.include('--image-* options only apply');
      expect(caught).to.include({ code: 'unknown-format', format: 'png' });
    });

    it('rejects a bad dashboard option without rendering or writing anything', async () => {
      const inputPath = path.join(tempRoot, 'brief.md');
      await writeFile(inputPath, '# Brief\n\nOne block.\n');

      await expectRejection(
        runConvert(inputPath, {
          outputDir: tempRoot,
          formats: 'png',
          imageStyle: 'neon',
        }),
        'Unknown dashboard style "neon"',
      );
      // A browser launch would have produced an image; nothing may be published.
      expect(await readdir(tempRoot)).to.deep.equal(['brief.md']);
    });

    it('rejects an out-of-range custom size without rendering or writing anything', async () => {
      const inputPath = path.join(tempRoot, 'brief.md');
      await writeFile(inputPath, '# Brief\n\nOne block.\n');

      await expectRejection(
        runConvert(inputPath, {
          outputDir: tempRoot,
          formats: 'png',
          imageWidth: '9000',
          imageHeight: '9000',
        }),
        'pixels',
      );
      expect(await readdir(tempRoot)).to.deep.equal(['brief.md']);
    });
  });

  describe('MCP exposure', () => {
    it('offers png as a convert_document target', () => {
      expect(MCP_CONVERSION_TARGET_FORMATS).to.include('png');
    });

    it('reports rendered fidelity for the dashboard image', () => {
      expect(MCP_FORMAT_FIDELITIES.png).to.deep.equal(['rendered-fidelity']);
    });

    it('keeps the resolution vocabulary in step with the linked renderer', () => {
      expect([...MCP_DASHBOARD_RESOLUTION_IDS]).to.deep.equal(
        DASHBOARD_RESOLUTIONS.map((preset) => preset.id),
      );
      expect(MCP_DASHBOARD_RESOLUTION_IDS).to.include(DEFAULT_DASHBOARD_RESOLUTION);
    });

    it('keeps the style vocabulary in step with the linked renderer', () => {
      expect([...MCP_DASHBOARD_STYLE_IDS]).to.deep.equal([...DASHBOARD_STYLE_IDS]);
    });
  });
});

async function docFor(markdown: string) {
  return markdownToDoc(parseMarkdown(markdown));
}

async function expectRejection(work: Promise<unknown>, fragment: string): Promise<void> {
  let caught: unknown;
  try {
    await work;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught, `expected a rejection containing "${fragment}"`).to.be.instanceOf(Error);
  expect(String(caught)).to.include(fragment);
}
