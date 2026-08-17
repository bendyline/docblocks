import { expect } from 'chai';
import { MCP_WIRE_LIMITS } from '@bendyline/docblocks/mcp';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import {
  MCP_FORMAT_FIDELITIES,
  UnsupportedFidelityError,
  convertPreparedDocument,
} from '../src/mcp/conversion-service.js';
import { DocumentService } from '../src/mcp/document-service.js';
import { callTool, startMcpHarness } from './mcp-helpers.js';

describe('MCP target fidelity contracts', () => {
  it('rejects an unsupported combination at the Zod tool boundary', async () => {
    const harness = await startMcpHarness();
    try {
      const result = await callTool(harness.client, 'convert_document', {
        source: { kind: 'markdown', markdown: '# Fidelity', name: null },
        targets: [{ format: 'docx', fidelity: 'hybrid' }],
      });
      expect(result.isError).to.equal(true);
      expect(result.text).to.include('Invalid arguments');
      expect(result.text).to.include('editable-native');
    } finally {
      await harness.dispose();
    }
  });

  it('rejects unsupported combinations in the conversion service with a stable error', async () => {
    const artifacts = new ArtifactStore();
    try {
      const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
      const prepared = await documents.prepare({
        kind: 'markdown',
        markdown: '# Fidelity\n\nSemantic body.',
        name: null,
      });
      try {
        await convertPreparedDocument(artifacts, prepared, {
          targets: [{ format: 'docx', fidelity: 'hybrid' }],
        });
        expect.fail('Expected unsupported fidelity');
      } catch (caught: unknown) {
        expect(caught).to.be.instanceOf(UnsupportedFidelityError);
        const error = caught as UnsupportedFidelityError;
        expect(error).to.include({ code: 'unsupported-fidelity', format: 'docx' });
        expect(error.message).to.equal('Fidelity "hybrid" is not supported for target "docx".');
        expect(error.hint).to.equal('Supported fidelities for docx: semantic, editable-native.');
      }
    } finally {
      await artifacts.dispose();
    }
  });

  it('publishes exact target truth and records both rendering engines', async () => {
    expect(MCP_FORMAT_FIDELITIES).to.deep.equal({
      md: ['semantic'],
      docx: ['semantic', 'editable-native'],
      pdf: ['semantic', 'rendered-fidelity', 'hybrid'],
      pptx: ['semantic', 'editable-native', 'rendered-fidelity', 'hybrid'],
      xlsx: ['semantic', 'editable-native'],
      csv: ['semantic'],
      html: ['semantic'],
      htmlzip: ['semantic'],
      epub: ['semantic'],
      dbk: ['semantic', 'editable-native'],
      mp4: ['rendered-fidelity'],
      gif: ['rendered-fidelity'],
      png: ['rendered-fidelity'],
    });

    const artifacts = new ArtifactStore();
    try {
      const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
      const prepared = await documents.prepare({
        kind: 'markdown',
        markdown: '# Provenance',
        name: 'provenance.md',
      });
      const [result] = await convertPreparedDocument(artifacts, prepared, {
        targets: [{ format: 'md', fidelity: 'semantic' }],
      });
      expect(result?.artifact.engineVersions.map(({ name }) => name)).to.deep.equal([
        'docblocks',
        '@bendyline/squisq-cli',
        '@bendyline/squisq-formats',
        '@bendyline/squisq',
      ]);
      expect(result?.artifact.engineVersions.slice(1).map(({ version }) => version)).to.satisfy(
        (versions: string[]) =>
          versions.every((version) => /\+runtime\.[a-f0-9]{16}$/u.test(version)),
      );
    } finally {
      await artifacts.dispose();
    }
  });

  it('publishes an exact source asset manifest with attribution and hashes', async () => {
    const artifacts = new ArtifactStore();
    try {
      const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const image = await artifacts.put({
        bytes: imageBytes,
        format: 'png',
        mimeType: 'image/png',
        suggestedFilename: 'diagram.png',
      });
      const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
      const prepared = await documents.prepare({
        kind: 'bundle',
        markdown: '# Assets\n\n![Architecture](media/diagram.png)',
        name: 'assets.md',
        assets: [
          {
            path: parseWorkspacePath('media/diagram.png'),
            source: { kind: 'artifact', uri: image.uri },
            mimeType: 'image/png',
            altText: 'Architecture diagram',
            credit: 'DocBlocks team',
            license: 'CC-BY-4.0',
          },
        ],
      });
      const [result] = await convertPreparedDocument(artifacts, prepared, {
        targets: [{ format: 'md', fidelity: 'semantic' }],
      });

      expect(result?.sourceAssetCount).to.equal(1);
      expect(result?.sourceAssets).to.deep.equal([
        {
          path: 'media/diagram.png',
          mimeType: 'image/png',
          size: imageBytes.byteLength,
          sha256: image.sha256,
          altText: 'Architecture diagram',
          credit: 'DocBlocks team',
          license: 'CC-BY-4.0',
        },
      ]);
    } finally {
      await artifacts.dispose();
    }
  });

  it('rejects malformed persisted asset manifests instead of treating corruption as absence', async () => {
    const artifacts = new ArtifactStore();
    try {
      const { MemoryContentContainer } = await import('@bendyline/squisq/storage');
      const container = new MemoryContentContainer();
      await container.writeDocument('# Invalid manifest');
      await container.writeFile(
        '.docblocks/assets.json',
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            assets: [
              {
                path: '../escape.png',
                mimeType: 'image/png',
                altText: null,
                credit: null,
                license: null,
              },
            ],
          }),
        ),
        'application/json',
      );
      const documents = new DocumentService(await McpFileAuthority.create(), artifacts);

      let error: unknown;
      try {
        await documents.assetSummaries(container);
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('asset manifest contains invalid metadata');
    } finally {
      await artifacts.dispose();
    }
  });

  it('rejects overlong or control-bearing persisted asset metadata at ingress', async () => {
    const artifacts = new ArtifactStore();
    try {
      const { MemoryContentContainer } = await import('@bendyline/squisq/storage');
      const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
      for (const altText of [
        'A'.repeat(MCP_WIRE_LIMITS.labelCharacters + 1),
        'unsafe\u007fmetadata',
      ]) {
        const container = new MemoryContentContainer();
        await container.writeDocument('# Invalid metadata');
        await container.writeFile(
          '.docblocks/assets.json',
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              assets: [
                {
                  path: 'media/pixel.png',
                  mimeType: 'image/png',
                  altText,
                  credit: null,
                  license: null,
                },
              ],
            }),
          ),
          'application/json',
        );

        let error: unknown;
        try {
          await documents.assetSummaries(container);
        } catch (caught: unknown) {
          error = caught;
        }
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('asset manifest contains invalid metadata');
      }
    } finally {
      await artifacts.dispose();
    }
  });
});
