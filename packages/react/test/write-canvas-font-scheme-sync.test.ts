import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { DOCBLOCKS_WRITE_CANVAS_FONT_SCHEMES } from '@bendyline/docblocks/vscode';
import { WRITE_CANVAS_FONT_SCHEMES } from '../src/preferences/write-canvas.js';

// The Write-canvas font scheme id is a shared contract with three sources of
// truth that cannot import each other cleanly: the react registry (this UI),
// the core wire/persisted enum, and the VS Code `package.json` config enum.
// Keep them identical so a scheme added in one place cannot silently break the
// wire validator or the VS Code setting.
describe('Write canvas font scheme id sync', () => {
  const reactIds = WRITE_CANVAS_FONT_SCHEMES.map((scheme) => scheme.id);

  it('matches the core wire/persisted enum', () => {
    expect(reactIds).to.deep.equal([...DOCBLOCKS_WRITE_CANVAS_FONT_SCHEMES]);
  });

  it('matches the VS Code package.json configuration enum', () => {
    const packageJsonUrl = new URL('../../vscode/package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), 'utf8')) as {
      contributes: {
        configuration: {
          properties: Record<string, { enum?: string[]; enumDescriptions?: string[] }>;
        };
      };
    };
    const property = pkg.contributes.configuration.properties['docblocks.writeCanvasFontScheme'];
    expect(property, 'docblocks.writeCanvasFontScheme contribution').to.not.equal(undefined);
    expect(property.enum).to.deep.equal(reactIds);
    // Every option needs a human description in the VS Code settings UI.
    expect(property.enumDescriptions).to.have.length(reactIds.length);
  });
});
