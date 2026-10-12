import { expect } from 'chai';
import {
  WORKSPACE_SETTINGS_JSON_SCHEMA,
  WORKSPACE_SETTINGS_LIMITS,
  applyWorkspaceSettingsPatch,
  checkCatalogOutputPath,
  diffWorkspaceSettings,
  isDefaultWorkspaceSettings,
  isEmptyWorkspaceSettingsPatch,
  parseWorkspaceSettingsPatch,
  parseWorkspaceSettingsText,
  resolveCatalogOutputs,
  resolveFallbackThemeId,
  resolveWorkspaceVersioningEnabled,
  serializeWorkspaceSettings,
  type WorkspaceSettings,
} from '../src/workspace-settings/index.js';

const FULL: WorkspaceSettings = {
  version: 1,
  documents: { defaultTheme: 'warm-earth' },
  versionHistory: { enabled: true, keep: 25 },
  catalog: {
    title: 'Articles',
    sort: 'date',
    exclude: ['drafts'],
    html: { enabled: true, path: 'index.html', theme: 'gezellig' },
    json: { enabled: true, path: 'data/catalog.json', content: 'metadata' },
  },
};

function parseOk(text: string): WorkspaceSettings {
  const result = parseWorkspaceSettingsText(text);
  if (result.status !== 'ok')
    throw new Error(`expected ok, got ${result.status}: ${result.message}`);
  return result.settings;
}

describe('workspace settings file', () => {
  it('round-trips the full v1 shape deterministically', () => {
    const text = serializeWorkspaceSettings(FULL);
    expect(parseOk(text)).to.deep.equal(FULL);
    expect(serializeWorkspaceSettings(parseOk(text))).to.equal(text);
    expect(text.endsWith('}\n')).to.equal(true);
    expect(text.indexOf('"version"')).to.be.lessThan(text.indexOf('"documents"'));
  });

  it('serializes keys in a fixed order regardless of input order', () => {
    const shuffled = JSON.stringify({
      catalog: { json: { content: 'metadata', enabled: true }, title: 'A' },
      versionHistory: { keep: 3, enabled: false },
      version: 1,
    });
    expect(serializeWorkspaceSettings(parseOk(shuffled))).to.equal(
      `${JSON.stringify(
        {
          version: 1,
          versionHistory: { enabled: false, keep: 3 },
          catalog: { title: 'A', json: { enabled: true, content: 'metadata' } },
        },
        null,
        2,
      )}\n`,
    );
  });

  it('accepts a byte-order mark, an optional $schema, and empty sections', () => {
    const settings = parseOk(`\uFEFF{"$schema":"./x.json","version":1,"documents":{}}`);
    expect(settings).to.deep.equal({ $schema: './x.json', version: 1 });
  });

  it('rejects unknown fields at every level instead of half-applying them', () => {
    for (const text of [
      '{"version":1,"extra":true}',
      '{"version":1,"documents":{"defaultTheme":"a","other":1}}',
      '{"version":1,"catalog":{"html":{"enabled":true,"script":"x"}}}',
    ]) {
      expect(parseWorkspaceSettingsText(text).status).to.equal('invalid');
    }
  });

  it('reports newer settings versions as unsupported, even with unknown fields', () => {
    const result = parseWorkspaceSettingsText('{"version":2,"future":{"x":1}}');
    expect(result.status).to.equal('unsupported-version');
  });

  it('rejects malformed JSON, missing versions, and oversized files', () => {
    expect(parseWorkspaceSettingsText('{').status).to.equal('invalid');
    expect(parseWorkspaceSettingsText('{"documents":{}}').status).to.equal('invalid');
    expect(parseWorkspaceSettingsText('[]').status).to.equal('invalid');
    const huge = `{"version":1,"$schema":"${'x'.repeat(WORKSPACE_SETTINGS_LIMITS.maxFileBytes)}"}`;
    expect(parseWorkspaceSettingsText(huge).status).to.equal('invalid');
  });

  it('bounds theme ids, titles, keep, and excludes', () => {
    for (const text of [
      '{"version":1,"documents":{"defaultTheme":"Warm Earth"}}',
      '{"version":1,"documents":{"defaultTheme":"../x"}}',
      '{"version":1,"versionHistory":{"keep":0}}',
      '{"version":1,"versionHistory":{"keep":1.5}}',
      `{"version":1,"versionHistory":{"keep":${WORKSPACE_SETTINGS_LIMITS.maxKeep + 1}}}`,
      '{"version":1,"catalog":{"title":""}}',
      `{"version":1,"catalog":{"title":"${'t'.repeat(WORKSPACE_SETTINGS_LIMITS.maxTitleCharacters + 1)}"}}`,
      `{"version":1,"catalog":{"exclude":${JSON.stringify(Array.from({ length: 65 }, (_, i) => `d${i}`))}}}`,
      '{"version":1,"catalog":{"exclude":["../up"]}}',
    ]) {
      expect(parseWorkspaceSettingsText(text).status, text).to.equal('invalid');
    }
  });

  it('normalizes exclude prefixes and drops duplicates', () => {
    const settings = parseOk('{"version":1,"catalog":{"exclude":["drafts/","/drafts","a\\\\b"]}}');
    expect(settings.catalog?.exclude).to.deep.equal(['drafts', 'a/b']);
  });
});

describe('catalog output paths', () => {
  it('accepts ordinary nested outputs with the right extension', () => {
    expect(checkCatalogOutputPath('index.html', 'html')).to.deep.equal({
      ok: true,
      path: 'index.html',
    });
    expect(checkCatalogOutputPath('site/catalog.htm', 'html').ok).to.equal(true);
    expect(checkCatalogOutputPath('data/catalog.json', 'json').ok).to.equal(true);
  });

  it('refuses hidden, companion, runtime, traversal, root, and wrong-extension paths', () => {
    for (const [path, kind] of [
      ['', 'html'],
      ['.docblocks/index.html', 'html'],
      ['a/.git/index.html', 'html'],
      ['Article_files/index.html', 'html'],
      ['_squisq/index.html', 'html'],
      ['node_modules/index.html', 'html'],
      ['../index.html', 'html'],
      ['C:/index.html', 'html'],
      ['index.json', 'html'],
      ['catalog.html', 'json'],
      ['index.html\u0000', 'html'],
    ] as const) {
      expect(checkCatalogOutputPath(path, kind).ok, `${kind}:${JSON.stringify(path)}`).to.equal(
        false,
      );
    }
  });
});

describe('workspace settings patches', () => {
  it('diffs and re-applies field-level changes', () => {
    const before: WorkspaceSettings = { version: 1, documents: { defaultTheme: 'warm-earth' } };
    const after: WorkspaceSettings = {
      version: 1,
      versionHistory: { enabled: false },
      catalog: { html: { enabled: true } },
    };
    const patch = diffWorkspaceSettings(before, after);
    expect(patch).to.deep.equal({
      documents: { defaultTheme: null },
      versionHistory: { enabled: false },
      catalog: { html: { enabled: true } },
    });
    expect(applyWorkspaceSettingsPatch(before, patch)).to.deep.equal(after);
  });

  it('merges a patch onto a concurrently changed file without losing either edit', () => {
    const original: WorkspaceSettings = { version: 1 };
    const mine: WorkspaceSettings = { version: 1, documents: { defaultTheme: 'warm-earth' } };
    const theirs: WorkspaceSettings = { version: 1, versionHistory: { keep: 10 } };
    const merged = applyWorkspaceSettingsPatch(theirs, diffWorkspaceSettings(original, mine));
    expect(merged).to.deep.equal({
      version: 1,
      documents: { defaultTheme: 'warm-earth' },
      versionHistory: { keep: 10 },
    });
  });

  it('removes sections that become empty and reports empty patches', () => {
    const patch = diffWorkspaceSettings(FULL, FULL);
    expect(isEmptyWorkspaceSettingsPatch(patch)).to.equal(true);
    expect(
      applyWorkspaceSettingsPatch(
        { version: 1, documents: { defaultTheme: 'a' } },
        { documents: { defaultTheme: null } },
      ),
    ).to.deep.equal({ version: 1 });
  });

  it('re-validates patched output', () => {
    expect(() =>
      applyWorkspaceSettingsPatch(null, { catalog: { html: { path: '.hidden/index.html' } } }),
    ).to.throw(/hidden/);
  });

  it('parses wire patches with exact shapes', () => {
    expect(
      parseWorkspaceSettingsPatch({
        documents: { defaultTheme: null },
        catalog: { html: { enabled: true, path: 'index.html' }, exclude: ['drafts/'] },
      }),
    ).to.deep.equal({
      documents: { defaultTheme: null },
      catalog: { exclude: ['drafts'], html: { enabled: true, path: 'index.html' } },
    });
    expect(() => parseWorkspaceSettingsPatch({ documents: { other: 1 } })).to.throw();
    expect(() => parseWorkspaceSettingsPatch({ version: 2 })).to.throw();
    expect(() => parseWorkspaceSettingsPatch({ catalog: { json: { path: 'x.html' } } })).to.throw();
  });
});

describe('default workspace settings', () => {
  it('treats settings that change nothing as defaults', () => {
    expect(isDefaultWorkspaceSettings(null)).to.equal(true);
    expect(isDefaultWorkspaceSettings({ version: 1 })).to.equal(true);
    // Configuration for outputs that are not turned on is inert.
    expect(
      isDefaultWorkspaceSettings({
        version: 1,
        catalog: {
          title: 'Articles',
          sort: 'date',
          exclude: ['drafts'],
          html: { enabled: false, path: 'site/index.html', theme: 'warm-earth' },
          json: { content: 'markdown' },
        },
      }),
    ).to.equal(true);
  });

  it('treats any active setting as worth saving', () => {
    for (const settings of [
      { version: 1, documents: { defaultTheme: 'warm-earth' } },
      { version: 1, versionHistory: { enabled: false } },
      { version: 1, versionHistory: { keep: 10 } },
      { version: 1, catalog: { html: { enabled: true } } },
      { version: 1, catalog: { json: { enabled: true } } },
    ] as const) {
      expect(isDefaultWorkspaceSettings(settings), JSON.stringify(settings)).to.equal(false);
    }
  });
});

describe('workspace settings resolution', () => {
  it('passes the workspace theme only to documents without their own', () => {
    expect(resolveFallbackThemeId(undefined, FULL)).to.equal('warm-earth');
    expect(resolveFallbackThemeId('gezellig', FULL)).to.equal(undefined);
    expect(resolveFallbackThemeId(undefined, null)).to.equal(undefined);
  });

  it('inherits version history unless the workspace decides', () => {
    expect(resolveWorkspaceVersioningEnabled(null)).to.equal(undefined);
    expect(resolveWorkspaceVersioningEnabled({ version: 1, versionHistory: { keep: 3 } })).to.equal(
      undefined,
    );
    expect(resolveWorkspaceVersioningEnabled(FULL)).to.equal(true);
  });

  it('resolves catalog outputs with defaults, and nothing when none are enabled', () => {
    expect(resolveCatalogOutputs({ version: 1 })).to.equal(null);
    expect(resolveCatalogOutputs({ version: 1, catalog: { html: { enabled: false } } })).to.equal(
      null,
    );
    expect(
      resolveCatalogOutputs({
        version: 1,
        documents: { defaultTheme: 'warm-earth' },
        catalog: { html: { enabled: true } },
      }),
    ).to.deep.equal({
      title: 'Documents',
      sort: 'title',
      exclude: [],
      html: { path: 'index.html', themeId: 'warm-earth' },
      json: null,
    });
    expect(resolveCatalogOutputs(FULL)?.html?.themeId).to.equal('gezellig');
  });
});

describe('workspace settings JSON schema', () => {
  it('describes exactly the sections and fields the runtime parser accepts', () => {
    const schema = WORKSPACE_SETTINGS_JSON_SCHEMA;
    expect(Object.keys(schema.properties).sort()).to.deep.equal(
      ['$schema', 'catalog', 'documents', 'version', 'versionHistory'].sort(),
    );
    expect(Object.keys(schema.properties.documents.properties)).to.deep.equal(['defaultTheme']);
    expect(Object.keys(schema.properties.versionHistory.properties)).to.deep.equal([
      'enabled',
      'keep',
    ]);
    const catalog = schema.properties.catalog.properties;
    expect(Object.keys(catalog)).to.deep.equal(['title', 'sort', 'exclude', 'html', 'json']);
    expect(Object.keys(catalog.html.properties)).to.deep.equal(['enabled', 'path', 'theme']);
    expect(Object.keys(catalog.json.properties)).to.deep.equal(['enabled', 'path', 'content']);
    expect(
      new RegExp(schema.properties.documents.properties.defaultTheme.pattern).test('warm-earth'),
    ).to.equal(true);
  });
});
