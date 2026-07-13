import { expect } from 'chai';
import {
  compareFormatCapabilities,
  isPathInside,
  type McpFormatCapability,
  type RegistryFormatCapability,
} from '../../../scripts/check-linked-squisq.js';

const REGISTRY_FORMAT: RegistryFormatCapability = {
  id: 'docx',
  label: 'Microsoft Word',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extensions: ['.docx'],
  canImport: true,
  canExport: true,
};

function manifestEntry(overrides: Partial<McpFormatCapability> = {}): McpFormatCapability {
  return {
    id: REGISTRY_FORMAT.id,
    label: REGISTRY_FORMAT.label,
    mimeType: REGISTRY_FORMAT.mimeType,
    extensions: REGISTRY_FORMAT.extensions,
    import: { supported: true, tool: 'inspect_document' },
    export: { supported: true, tool: 'convert_document' },
    ...overrides,
  };
}

describe('linked Squisq assurance check', () => {
  it('accepts an exact, explicitly exposed capability manifest', () => {
    expect(compareFormatCapabilities([REGISTRY_FORMAT], [manifestEntry()])).to.deep.equal([]);
  });

  it('requires every linked capability to be exposed or explicitly excluded', () => {
    const issues = compareFormatCapabilities(
      [REGISTRY_FORMAT],
      [
        manifestEntry({
          import: { supported: true },
          export: {
            supported: true,
            excludedReason: 'Rendered export is intentionally not exposed over MCP.',
          },
        }),
      ],
    );

    expect(issues).to.deep.equal([
      'docx: supported input must declare exactly one of tool or excludedReason',
    ]);
  });

  it('detects missing, extra, and drifted registry formats', () => {
    const issues = compareFormatCapabilities(
      [REGISTRY_FORMAT],
      [
        manifestEntry({ mimeType: 'application/octet-stream' }),
        {
          ...manifestEntry(),
          id: 'invented',
        },
      ],
    );

    expect(issues).to.include(
      'docx: MIME type differs (Squisq="application/vnd.openxmlformats-officedocument.wordprocessingml.document", MCP="application/octet-stream")',
    );
    expect(issues).to.include('MCP manifest contains a format absent from linked Squisq: invented');
    expect(compareFormatCapabilities([REGISTRY_FORMAT], [])).to.deep.equal([
      'linked Squisq format is absent from MCP manifest: docx',
    ]);
  });

  it('fails closed when a linked exporter is absent from convert_document input', () => {
    expect(compareFormatCapabilities([REGISTRY_FORMAT], [manifestEntry()], [])).to.deep.equal([
      'linked Squisq export format is not accepted by convert_document: docx',
    ]);
  });

  it('rejects old or unrelated tool names in the exposure manifest', () => {
    const entry = manifestEntry();
    const issues = compareFormatCapabilities(
      [REGISTRY_FORMAT],
      [{ ...entry, export: { supported: true, tool: 'export_markdown_to_docx' } }],
      ['docx'],
    );
    expect(issues).to.include('docx: supported output must use canonical tool convert_document');
  });

  it('uses physical containment rather than a string-prefix check', () => {
    const parent =
      process.platform === 'win32' ? 'D:\\gh\\squisq\\packages' : '/work/squisq/packages';
    const child =
      process.platform === 'win32'
        ? 'D:\\gh\\squisq\\packages\\formats'
        : '/work/squisq/packages/formats';
    const siblingPrefix =
      process.platform === 'win32'
        ? 'D:\\gh\\squisq\\packages-escape\\formats'
        : '/work/squisq/packages-escape/formats';

    expect(isPathInside(parent, child)).to.equal(true);
    expect(isPathInside(parent, siblingPrefix)).to.equal(false);
  });
});
