import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCBLOCKS_MCP_TOOL_NAMES } from '@bendyline/docblocks/mcp';
import { buildCommand } from '../src/commands/build.js';
import { convertCommand } from '../src/commands/convert.js';
import { initCommand } from '../src/commands/init.js';
import { mcpCommand } from '../src/commands/mcp.js';
import { parseCommand } from '../src/commands/parse.js';
import { serveCommand } from '../src/commands/serve.js';
import { themesCommand } from '../src/commands/themes.js';
import { transformsCommand } from '../src/commands/transforms.js';
import { videoCommand } from '../src/commands/video.js';
import { MCP_FORMAT_CAPABILITIES } from '../src/mcp/conversion-service.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const IMPLEMENTED_COMMAND_NAMES = [
  initCommand,
  buildCommand,
  serveCommand,
  convertCommand,
  videoCommand,
  mcpCommand,
  themesCommand,
  transformsCommand,
  parseCommand,
].map((command) => command.name());

interface DocumentedFormat {
  id: string;
  import: 'yes' | 'no';
  export: 'yes' | 'no';
}

describe('authoritative CLI and MCP documentation', () => {
  let cliGuide = '';
  let mcpGuide = '';
  let rootReadme = '';
  let packageReadme = '';
  let agentGuidance = '';

  before(async () => {
    [cliGuide, mcpGuide, rootReadme, packageReadme, agentGuidance] = await Promise.all([
      readRepositoryFile('docs/cli.md'),
      readRepositoryFile('docs/mcp.md'),
      readRepositoryFile('README.md'),
      readRepositoryFile('packages/cli/README.md'),
      readRepositoryFile('AGENTS.md'),
    ]);
  });

  it('keeps the CLI command catalog synchronized with registered commands', () => {
    expect(readCodeColumn(cliGuide, 'CLI COMMAND CATALOG')).to.deep.equal(
      IMPLEMENTED_COMMAND_NAMES,
    );
  });

  it('keeps the MCP tool catalog synchronized with the canonical core tuple', () => {
    expect(readCodeColumn(mcpGuide, 'MCP TOOL CATALOG')).to.deep.equal([
      ...DOCBLOCKS_MCP_TOOL_NAMES,
    ]);
  });

  it('keeps both format catalogs synchronized with the linked Squisq registry', () => {
    const expected = MCP_FORMAT_CAPABILITIES.map<DocumentedFormat>((format) => ({
      id: format.id,
      import: format.import.supported ? 'yes' : 'no',
      export: format.export.supported ? 'yes' : 'no',
    }));

    expect(readFormatCatalog(cliGuide)).to.deep.equal(expected);
    expect(readFormatCatalog(mcpGuide)).to.deep.equal(expected);
  });

  it('links readers to the authoritative guides from repository entry points', () => {
    expect(rootReadme).to.include('[CLI reference](docs/cli.md)');
    expect(rootReadme).to.include('[MCP architecture and protocol guide](docs/mcp.md)');
    expect(packageReadme).to.include(
      'https://github.com/bendyline/docblocks/blob/main/docs/cli.md',
    );
    expect(packageReadme).to.include(
      'https://github.com/bendyline/docblocks/blob/main/docs/mcp.md',
    );
    expect(agentGuidance).to.include('[`docs/cli.md`](docs/cli.md)');
    expect(agentGuidance).to.include('[`docs/mcp.md`](docs/mcp.md)');
  });
});

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
}

function readMarkedSection(markdown: string, marker: string): string {
  const beginMarker = `<!-- BEGIN ${marker} -->`;
  const endMarker = `<!-- END ${marker} -->`;
  const begin = markdown.indexOf(beginMarker);
  const end = markdown.indexOf(endMarker);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error(`Documentation marker pair is missing or invalid: ${marker}`);
  }
  if (markdown.indexOf(beginMarker, begin + beginMarker.length) >= 0) {
    throw new Error(`Documentation marker is duplicated: ${beginMarker}`);
  }
  if (markdown.indexOf(endMarker, end + endMarker.length) >= 0) {
    throw new Error(`Documentation marker is duplicated: ${endMarker}`);
  }
  return markdown.slice(begin + beginMarker.length, end);
}

function readCodeColumn(markdown: string, marker: string): string[] {
  return readMarkedSection(markdown, marker)
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^\|\s*`([^`]+)`\s*\|/u.exec(line);
      return match ? [match[1]!] : [];
    });
}

function readFormatCatalog(markdown: string): DocumentedFormat[] {
  return readMarkedSection(markdown, 'FORMAT CATALOG')
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^\|\s*`([^`]+)`\s*\|\s*(yes|no)\s*\|\s*(yes|no)\s*\|/u.exec(line);
      return match
        ? [
            {
              id: match[1]!,
              import: match[2]! as 'yes' | 'no',
              export: match[3]! as 'yes' | 'no',
            },
          ]
        : [];
    });
}
