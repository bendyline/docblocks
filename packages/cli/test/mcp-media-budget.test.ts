import { expect } from 'chai';
import { CapturedFrameBudgetError } from '@bendyline/squisq-cli/api';
import { ConversionError } from '@bendyline/squisq-formats';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import {
  MediaRenderBudgetError,
  convertPreparedDocument,
  type ConversionServiceDependencies,
} from '../src/mcp/conversion-service.js';
import { DocumentService } from '../src/mcp/document-service.js';

describe('MCP rendered-media preflight budgets', () => {
  it('rejects excessive MP4 frame-pixels before preparing or launching a renderer', async () => {
    const artifacts = new ArtifactStore();
    let preparedConversions = 0;
    try {
      const prepared = await prepare(artifacts, 60);
      let caught: unknown;
      try {
        await convertPreparedDocument(
          artifacts,
          prepared,
          {
            targets: [
              {
                format: 'mp4',
                fidelity: 'rendered-fidelity',
                options: { width: 3_840, height: 2_160, fps: 60 },
              },
            ],
          },
          undefined,
          undefined,
          dependencies(() => {
            preparedConversions += 1;
          }),
        );
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).to.be.instanceOf(MediaRenderBudgetError);
      expect(caught).to.include({ code: 'media-budget-exceeded', format: 'mp4' });
      expect(String(caught)).to.include('frame-pixels');
      expect(preparedConversions).to.equal(0);
      expect(await artifacts.completeIds('')).to.deep.equal([]);
    } finally {
      await artifacts.dispose();
    }
  });

  it('applies a tighter aggregate capture budget to animated GIF', async () => {
    const artifacts = new ArtifactStore();
    try {
      const prepared = await prepare(artifacts, 90);
      let caught: unknown;
      try {
        await convertPreparedDocument(artifacts, prepared, {
          targets: [
            {
              format: 'gif',
              fidelity: 'rendered-fidelity',
              options: { width: 1_920, height: 1_080, fps: 30 },
            },
          ],
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(MediaRenderBudgetError);
      expect(caught).to.include({ code: 'media-budget-exceeded', format: 'gif' });
    } finally {
      await artifacts.dispose();
    }
  });

  it('allows a bounded MP4 render and reports its truthful rendered fidelity', async () => {
    const artifacts = new ArtifactStore();
    let preparedConversions = 0;
    try {
      const prepared = await prepare(artifacts, 2);
      const [result] = await convertPreparedDocument(
        artifacts,
        prepared,
        {
          targets: [{ format: 'mp4', options: { width: 640, height: 360, fps: 15 } }],
        },
        undefined,
        undefined,
        dependencies(() => {
          preparedConversions += 1;
        }),
      );

      expect(preparedConversions).to.equal(1);
      expect(result).to.include({ targetFormat: 'mp4', fidelity: 'rendered-fidelity' });
    } finally {
      await artifacts.dispose();
    }
  });

  it('maps the linked renderer byte ceiling through a wrapped native conversion error', async () => {
    const artifacts = new ArtifactStore();
    try {
      const prepared = await prepare(artifacts, 2);
      const linkedBudgetError = new CapturedFrameBudgetError(200, 80, 256);
      const wrappedError = new ConversionError('conversion-failed', 'native conversion failed', {
        format: 'gif',
        cause: linkedBudgetError,
      });
      let caught: unknown;

      try {
        await convertPreparedDocument(
          artifacts,
          prepared,
          {
            targets: [
              {
                format: 'gif',
                fidelity: 'rendered-fidelity',
                options: { width: 640, height: 360, fps: 15 },
              },
            ],
          },
          undefined,
          undefined,
          dependencies(() => undefined, wrappedError),
        );
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).to.be.instanceOf(MediaRenderBudgetError);
      expect(caught).to.include({ code: 'media-budget-exceeded', format: 'gif' });
      expect(String(caught)).to.include('280 captured PNG bytes');
      expect((caught as MediaRenderBudgetError).hint).to.include('retained captured-PNG bytes');
      expect(await artifacts.completeIds('')).to.deep.equal([]);
    } finally {
      await artifacts.dispose();
    }
  });
});

async function prepare(artifacts: ArtifactStore, duration: number) {
  const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
  const prepared = await documents.prepare({
    kind: 'markdown',
    markdown: '# Media budget\n\nA bounded timeline.',
    name: 'media-budget.md',
  });
  prepared.doc.duration = duration;
  return prepared;
}

function dependencies(onPrepare: () => void, convertError?: Error): ConversionServiceDependencies {
  return {
    async prepareNativeConversion() {
      onPrepare();
      return {
        async convert(format) {
          if (convertError) throw convertError;
          return {
            bytes: new TextEncoder().encode(`bounded ${format}`),
            mimeType: format === 'mp4' ? 'video/mp4' : 'image/gif',
            suggestedFilename: `bounded.${format}`,
            warnings: [],
          };
        },
      };
    },
    async convertRenderedDocument() {
      throw new Error('The office-document rasterizer must not handle MP4/GIF');
    },
  };
}
