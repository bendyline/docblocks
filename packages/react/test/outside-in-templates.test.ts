import { expect } from 'chai';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import type { DocumentCommitRequest } from '@bendyline/docblocks/document';
import {
  OutsideInTemplateError,
  createNewOutsideInDocument,
  createOutsideInDocumentTarget,
  findPageTemplates,
  loadEditableShellDocument,
  rerenderPagesUsingTemplate,
  type OutsideInRenderOptions,
} from '../src/DocBlocksShell/outside-in.js';
import { loadPageTemplateEngine } from '../src/DocBlocksShell/outside-in-contract.js';
import type { SocialImageContent } from '../src/DocBlocksShell/social-image.js';
import { importDroppedFiles } from '../src/DocBlocksShell/import-files.js';

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title><slot name="title">Post</slot> · My Blog</title>
  <link rel="stylesheet" href="../css/site.css">
</head>
<body>
  <header><a href="../index.html">My Blog</a></header>
  <article>
    <time><slot name="date">Undated</slot></time>
    <slot>Post content goes here.</slot>
  </article>
</body>
</html>
`;

function request(
  targetKey: string,
  content: string,
  persistedContent: string,
): DocumentCommitRequest {
  return {
    targetKey,
    content,
    revision: 2,
    persistedRevision: 1,
    persistedContent,
    reason: 'manual',
  };
}

function withFrontmatter(content: string, fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return content.replace(/^---\n/, `---\n${lines.join('\n')}\n`);
}

async function blogWorkspace(name: string): Promise<MemoryFileSystemProvider> {
  const provider = new MemoryFileSystemProvider(name, name);
  await provider.writeFile('_templates/post.html', TEMPLATE);
  await provider.writeFile('css/site.css', 'body { color: navy; }');
  return provider;
}

const workspaceDefault: OutsideInRenderOptions = {
  defaultOutputTemplate: (format) => (format === 'html' ? '_templates/post.html' : undefined),
};

describe('outside-in page templates', function () {
  this.timeout(30_000);

  before(async function () {
    // The engine ships in Squisq; an installed release that predates it
    // leaves nothing here to exercise.
    if (!(await loadPageTemplateEngine())) this.skip();
  });

  it('generates a static page through the workspace default template', async () => {
    const provider = await blogWorkspace('template-default');
    const created = await createNewOutsideInDocument(
      provider,
      'posts/2026/hello.html',
      'static',
      workspaceDefault,
    );
    const target = createOutsideInDocumentTarget(
      provider,
      created.outsideIn,
      undefined,
      workspaceDefault,
    );
    const next = withFrontmatter(
      created.content.replace('# hello', '# Hello world\n\nFirst post.'),
      { date: '2026-10-28' },
    );
    await target.commit(request(target.key, next, created.content));

    const page = (await provider.readFile('posts/2026/hello.html'))!;
    expect(page.startsWith('<!doctype html>\n<html lang="en">')).to.equal(true);
    expect(page).to.contain('<title>Hello world · My Blog</title>');
    expect(page).to.contain('<link rel="stylesheet" href="../../css/site.css">');
    expect(page).to.contain('<a href="../../index.html">My Blog</a>');
    expect(page).to.contain('<time>2026-10-28</time>');
    expect(page).to.contain('<!-- squisq:content -->');
    expect(page).to.contain('<p>First post.</p>');
    expect(page).not.to.contain('<slot');
    // Only functional CSS, placed before the template's own stylesheet.
    expect(page).to.contain('<style data-squisq>');
    expect(page.indexOf('<style data-squisq>')).to.be.lessThan(page.indexOf('site.css'));
    expect(page).not.to.match(/\bbody \{/);
  });

  it('uses a template the companion names, relative or rooted, and honors none', async () => {
    const provider = await blogWorkspace('template-authored');
    const created = await createNewOutsideInDocument(provider, 'about.html', 'static');
    const target = createOutsideInDocumentTarget(provider, created.outsideIn);

    const relative = withFrontmatter(created.content, {
      'squisq-output-template': '../_templates/post.html',
    });
    await target.commit(request(target.key, relative, created.content));
    expect(await provider.readFile('about.html')).to.contain('· My Blog</title>');
    expect(await provider.readFile('about.html')).to.contain('href="css/site.css"');

    const rooted = withFrontmatter(created.content, {
      'squisq-output-template': '/_templates/post.html',
    });
    await target.commit(request(target.key, rooted, relative));
    expect(await provider.readFile('about.html')).to.contain('· My Blog</title>');

    const optedOut = withFrontmatter(created.content, { 'squisq-output-template': 'none' });
    const optedOutTarget = createOutsideInDocumentTarget(
      provider,
      created.outsideIn,
      undefined,
      workspaceDefault,
    );
    await optedOutTarget.commit(request(optedOutTarget.key, optedOut, rooted));
    const plain = (await provider.readFile('about.html'))!;
    expect(plain).not.to.contain('My Blog');
    expect(plain).to.contain('<title>about</title>');
  });

  it('keeps interactive pages on the player and reports a template named for one', async () => {
    const provider = await blogWorkspace('template-interactive');
    const created = await createNewOutsideInDocument(
      provider,
      'deck.html',
      'interactive',
      workspaceDefault,
    );
    expect(await provider.readFile('deck.html')).to.contain('squisq-player.js');
    expect(await provider.readFile('deck.html')).not.to.contain('My Blog');

    const blocked: Array<OutsideInTemplateError | null> = [];
    const target = createOutsideInDocumentTarget(provider, created.outsideIn, (renderBlocked) =>
      blocked.push(renderBlocked),
    );
    const named = withFrontmatter(created.content, {
      'squisq-output-template': '/_templates/post.html',
    });
    await target.commit(request(target.key, named, created.content));
    expect(blocked).to.have.length(1);
    expect(blocked[0]).to.be.instanceOf(OutsideInTemplateError);
    expect(blocked[0]?.message).to.match(/Interactive Web pages/);
    expect(await provider.readFile(created.sourcePath)).to.equal(named);
    expect(await provider.readFile('deck.html')).to.contain('squisq-player.js');
  });

  it('saves the Markdown but keeps the last good page when the template is missing or unusable', async () => {
    const provider = await blogWorkspace('template-missing');
    const created = await createNewOutsideInDocument(provider, 'post.html', 'static');
    const blocked: Array<OutsideInTemplateError | null> = [];
    const target = createOutsideInDocumentTarget(provider, created.outsideIn, (renderBlocked) =>
      blocked.push(renderBlocked),
    );
    const before = await provider.readFile('post.html');
    const marker = `${created.outsideIn.companionDirectory}/.docblocks-pending-render`;
    let persisted = created.content;

    for (const [template, message] of [
      ['/_templates/gone.html', /was not found/],
      ['/css/site.css', /must be an \.html file/],
      ['/post.html', /its own template/],
      ['../../outside.html', /must be an \.html file/],
    ] as const) {
      const next = withFrontmatter(created.content.replace('# post', `# Changed ${template}`), {
        'squisq-output-template': template,
      });
      await target.commit(request(target.key, next, persisted));
      persisted = next;
      const renderBlocked = blocked.at(-1);
      expect(renderBlocked, template).to.be.instanceOf(OutsideInTemplateError);
      expect(renderBlocked?.message, template).to.match(message);
      expect(await provider.readFile('post.html'), template).to.equal(before);
      expect(await provider.readFile(created.sourcePath), template).to.equal(next);
      expect(await provider.exists(marker), template).to.equal(true);
    }

    await provider.writeFile('_templates/broken.html', '<p><slot name="title"></slot></p>');
    const broken = withFrontmatter(created.content, {
      'squisq-output-template': '/_templates/broken.html',
    });
    await target.commit(request(target.key, broken, persisted));
    expect(blocked.at(-1)?.message).to.match(/no unnamed <slot>/);
    expect(await provider.readFile(created.sourcePath)).to.equal(broken);
    expect(await provider.readFile('post.html')).to.equal(before);
  });

  it('finishes a blocked render once the template is back, and still opens while it is not', async () => {
    const provider = await blogWorkspace('template-restored');
    const created = await createNewOutsideInDocument(
      provider,
      'posts/hello.html',
      'static',
      workspaceDefault,
    );
    const marker = `${created.outsideIn.companionDirectory}/.docblocks-pending-render`;
    const blocked: Array<OutsideInTemplateError | null> = [];
    const target = createOutsideInDocumentTarget(
      provider,
      created.outsideIn,
      (renderBlocked) => blocked.push(renderBlocked),
      workspaceDefault,
    );

    // The template disappears (deleted or renamed) while the page is open.
    await provider.delete('_templates/post.html');
    const edited = created.content.replace('# hello', '# Hello\n\nAn hour of typing.');
    await target.commit(request(target.key, edited, created.content));
    expect(blocked.at(-1)?.message).to.match(/was not found/);
    expect(await provider.readFile(created.sourcePath)).to.equal(edited);
    expect(await provider.readFile('posts/hello.html')).not.to.contain('An hour of typing.');

    // Reopening while the template is still missing opens the saved Markdown.
    const reopened = await loadEditableShellDocument(
      provider,
      'posts/hello.html',
      workspaceDefault,
    );
    expect(reopened?.content).to.equal(edited);
    expect(reopened?.renderBlocked).to.be.instanceOf(OutsideInTemplateError);
    expect(await provider.exists(marker)).to.equal(true);

    // With the template back, the next open finishes the render it owed.
    await provider.writeFile('_templates/post.html', TEMPLATE);
    const restored = await loadEditableShellDocument(
      provider,
      'posts/hello.html',
      workspaceDefault,
    );
    expect(restored?.renderBlocked).to.equal(undefined);
    expect(await provider.readFile('posts/hello.html')).to.contain('<p>An hour of typing.</p>');
    expect(await provider.exists(marker)).to.equal(false);

    // A later save renders normally and reports nothing blocked.
    const more = `${edited}\nMore.\n`;
    await target.commit(request(target.key, more, edited));
    expect(blocked.at(-1)).to.equal(null);
    expect(await provider.readFile('posts/hello.html')).to.contain('<p>More.</p>');
  });

  it('regenerates the pages that use a template after it changes', async () => {
    const provider = await blogWorkspace('template-rerender');
    const first = await createNewOutsideInDocument(
      provider,
      'posts/first.html',
      'static',
      workspaceDefault,
    );
    await createNewOutsideInDocument(provider, 'posts/second.html', 'static', workspaceDefault);
    const own = await createNewOutsideInDocument(provider, 'about.html', 'static');
    const ownTarget = createOutsideInDocumentTarget(provider, own.outsideIn);
    const optedOut = withFrontmatter(own.content, { 'squisq-output-template': 'none' });
    await ownTarget.commit(request(ownTarget.key, optedOut, own.content));
    await createNewOutsideInDocument(provider, 'deck.html', 'interactive', workspaceDefault);
    const aboutBefore = await provider.readFile('about.html');
    const deckBefore = await provider.readFile('deck.html');

    await provider.writeFile(
      '_templates/post.html',
      TEMPLATE.replace('My Blog</a>', 'My Blog</a> <a href="../archive.html">Archive</a>'),
    );
    const result = await rerenderPagesUsingTemplate(
      provider,
      '_templates/post.html',
      workspaceDefault,
    );
    expect(result).to.deep.equal({
      updated: ['posts/first.html', 'posts/second.html'],
      failed: [],
    });
    expect(await provider.readFile('posts/first.html')).to.contain(
      '<a href="../archive.html">Archive</a>',
    );
    expect(await provider.readFile(first.sourcePath)).to.equal(first.content);
    expect(await provider.readFile('about.html')).to.equal(aboutBefore);
    expect(await provider.readFile('deck.html')).to.equal(deckBefore);

    // Nothing changed since: nothing is rewritten.
    expect(
      (await rerenderPagesUsingTemplate(provider, '_templates/post.html', workspaceDefault))
        .updated,
    ).to.deep.equal([]);
  });

  describe('social preview pictures', function () {
    const SOCIAL_TEMPLATE = TEMPLATE.replace(
      '</head>',
      `  <meta property="og:image" content="https://example.com/logo.png">
  <meta property="og:image:alt" content="Logo">
  <meta name="twitter:image" content="https://example.com/logo.png">
</head>`,
    ).replace(
      '<article>',
      '<article>\n    <slot name="og-image"><img src="../img/logo.png" alt=""></slot>',
    );

    before(async function () {
      // Squisq fills image metadata from releases that report `usesImage`.
      const engine = await loadPageTemplateEngine();
      if (engine?.inspectHtmlPageTemplate('<meta property="og:image"><slot/>').usesImage !== true) {
        this.skip();
      }
    });

    function painterLog(): {
      painted: SocialImageContent[];
      render: OutsideInRenderOptions;
    } {
      const painted: SocialImageContent[] = [];
      return {
        painted,
        render: {
          ...workspaceDefault,
          defaultThemeId: () => 'warm-earth',
          siteUrl: () => 'https://example.com/blog/',
          renderSocialImage: async (content) => {
            painted.push(content);
            return new TextEncoder().encode(`png:${content.title}`);
          },
        },
      };
    }

    it('paints one in the document theme and links it from the page', async () => {
      const provider = await blogWorkspace('social-image');
      await provider.writeFile('_templates/post.html', SOCIAL_TEMPLATE);
      const { painted, render } = painterLog();
      const created = await createNewOutsideInDocument(
        provider,
        'posts/hello world.html',
        'static',
        render,
      );
      const target = createOutsideInDocumentTarget(provider, created.outsideIn, undefined, render);
      const next = withFrontmatter(
        created.content.replace('# hello world', '# Hello world\n\nFirst post.'),
        { description: 'A first post' },
      );
      await target.commit(request(target.key, next, created.content));

      expect(painted.at(-1)).to.deep.include({
        title: 'Hello world',
        description: 'A first post',
        site: 'example.com',
      });
      expect(painted.at(-1)?.theme.id).to.equal('warm-earth');
      const picture = await provider.readBinary('posts/hello world_files/og-image.png');
      expect(new TextDecoder().decode(picture!)).to.equal('png:Hello world');

      const page = (await provider.readFile('posts/hello world.html'))!;
      const version = /og-image\.png\?v=([0-9a-f]{8})"/.exec(page)?.[1];
      expect(version).to.be.a('string');
      expect(page).to.contain(
        `<meta property="og:image" content="https://example.com/blog/posts/hello%20world_files/og-image.png?v=${version}">`,
      );
      expect(page).to.contain(
        `<meta name="twitter:image" content="https://example.com/blog/posts/hello%20world_files/og-image.png?v=${version}">`,
      );
      expect(page).to.contain('<meta property="og:image:alt" content="Hello world">');
      expect(page).to.contain(
        `<img src="hello%20world_files/og-image.png?v=${version}" alt="Hello world" width="1200" height="630">`,
      );

      // A save that changes nothing on the card paints nothing new.
      const count = painted.length;
      const edited = next.replace('First post.', 'First post, edited.');
      await target.commit(request(target.key, edited, next));
      expect(painted).to.have.length(count);

      // A changed title is a new picture at a new URL.
      await target.commit(request(target.key, edited.replace('# Hello world', '# Hi'), edited));
      const renamed = (await provider.readFile('posts/hello world.html'))!;
      expect(renamed).not.to.contain(`?v=${version}`);
      expect(
        new TextDecoder().decode(
          (await provider.readBinary('posts/hello world_files/og-image.png'))!,
        ),
      ).to.equal('png:Hi');
    });

    it('links the picture relative to the page without a site address', async () => {
      const provider = await blogWorkspace('social-image-relative');
      await provider.writeFile('_templates/post.html', SOCIAL_TEMPLATE);
      const { render } = painterLog();
      await createNewOutsideInDocument(provider, 'hello.html', 'static', {
        ...render,
        siteUrl: () => undefined,
      });
      const page = (await provider.readFile('hello.html'))!;
      expect(page).to.match(
        /<meta property="og:image" content="hello_files\/og-image\.png\?v=[0-9a-f]{8}">/,
      );
    });

    it('keeps the template image when the template shows none, painting is off, or it fails', async () => {
      const provider = await blogWorkspace('social-image-off');
      const { painted, render } = painterLog();
      await createNewOutsideInDocument(provider, 'plain.html', 'static', render);
      expect(painted).to.have.length(0);
      expect(await provider.exists('plain_files/og-image.png')).to.equal(false);

      await provider.writeFile('_templates/post.html', SOCIAL_TEMPLATE);
      await createNewOutsideInDocument(provider, 'off.html', 'static', {
        ...render,
        renderSocialImage: null,
      });
      await createNewOutsideInDocument(provider, 'broken.html', 'static', {
        ...render,
        renderSocialImage: () => Promise.reject(new Error('no canvas')),
      });
      for (const name of ['off', 'broken']) {
        const page = (await provider.readFile(`${name}.html`))!;
        expect(page).to.contain(
          '<meta property="og:image" content="https://example.com/logo.png">',
        );
        expect(page).to.contain('<img src="img/logo.png" alt="">');
        expect(await provider.exists(`${name}_files/og-image.png`)).to.equal(false);
      }
    });

    it('repaints when a template starts showing one', async () => {
      const provider = await blogWorkspace('social-image-rerender');
      const { painted, render } = painterLog();
      await createNewOutsideInDocument(provider, 'posts/first.html', 'static', render);
      expect(painted).to.have.length(0);
      await provider.writeFile('_templates/post.html', SOCIAL_TEMPLATE);
      const result = await rerenderPagesUsingTemplate(provider, '_templates/post.html', render);
      expect(result).to.deep.equal({ updated: ['posts/first.html'], failed: [] });
      expect(await provider.exists('posts/first_files/og-image.png')).to.equal(true);
      expect(await provider.readFile('posts/first.html')).to.contain(
        'content="https://example.com/blog/posts/first_files/og-image.png?v=',
      );
    });
  });

  it('finds the page templates a document settings picker offers', async () => {
    const provider = await blogWorkspace('template-find');
    await provider.writeFile('layouts/landing.htm', '<main><slot/></main>');
    await provider.writeFile('notes/plain.html', '<p>Just a page.</p>');
    await provider.writeFile('.hidden/secret.html', '<slot></slot>');
    await createNewOutsideInDocument(provider, 'posts/hello.html', 'static', workspaceDefault);

    expect(await findPageTemplates(provider)).to.deep.equal([
      '_templates/post.html',
      'layouts/landing.htm',
    ]);
  });

  it('opens a template as HTML source instead of importing it', async () => {
    const provider = await blogWorkspace('template-open');
    const opened = await loadEditableShellDocument(provider, '_templates/post.html');
    expect(opened?.content).to.equal(TEMPLATE);
    expect(opened?.sourcePath).to.equal('_templates/post.html');
    expect(opened?.outsideIn).to.equal(null);
    expect(opened?.outsideInEditingEnabled).to.equal(true);
    expect(await provider.exists('_templates/post_files')).to.equal(false);
  });

  it('draws diagrams and charts, fills data tables, and links companion files', async () => {
    const provider = await blogWorkspace('template-pictures');
    const created = await createNewOutsideInDocument(
      provider,
      'posts/report.html',
      'static',
      workspaceDefault,
    );
    const companion = created.outsideIn.companionDirectory;
    await provider.writeFile(
      `${companion}/data/sales.csv`,
      'Region,Revenue\nNorth,120\nSouth,90\n',
    );
    await provider.writeFile(`${companion}/brief.zip`, 'zip');
    // A 1×1 PNG: drawing needs a browser, so a stand-in renderer supplies it.
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      ),
      (char) => char.charCodeAt(0),
    );
    const drawn: string[] = [];
    const render: OutsideInRenderOptions = {
      ...workspaceDefault,
      renderDiagram: async (diagram) => {
        drawn.push(diagram.kind);
        return { data: png, width: 320, height: 160 };
      },
    };
    const target = createOutsideInDocumentTarget(provider, created.outsideIn, undefined, render);
    const next = created.content.replace(
      '# report',
      [
        '# Report',
        '',
        '```mermaid',
        'flowchart LR',
        '  a --> b',
        '```',
        '',
        '## Revenue {[barChart src=data/sales.csv]}',
        '',
        '## Ledger {[dataTable src=data/sales.csv]}',
        '',
        '[sales.csv](data/sales.csv)',
        '',
        '{[audio src=narration.webm]}',
        '',
        'The [brief](brief.zip) {[fa-solid:paperclip]}.',
        '',
        '## Outlook',
        '',
        'Growth will continue {[statHighlight]}',
      ].join('\n'),
    );
    await target.commit(request(target.key, next, created.content));

    const page = (await provider.readFile('posts/report.html'))!;
    expect(drawn).to.deep.equal(['mermaid', 'chart']);
    expect(page.match(/<img src="data:image\/png;base64,/g)).to.have.length(2);
    expect(page).not.to.contain('flowchart LR');
    expect(page).to.contain('alt="Revenue: bar chart of Revenue by Region" width="320"');
    expect(page).to.contain('<h2>Ledger</h2>\n<table>');
    expect(page).to.contain('<td>North</td><td>120</td>');
    expect(page).to.contain('<a href="report_files/data/sales.csv">sales.csv</a>');
    expect(page).to.contain('<a href="report_files/brief.zip">brief</a>');
    expect(page).to.contain('<audio class="squisq-media" src="narration.webm"');
    expect(page).to.contain('<p>Growth will continue</p>');
    expect(page).not.to.contain('{[');
    // Icons are inline SVG: the page needs no icon font.
    expect(page).to.contain('<svg class="squisq-icon"');
    expect(page).not.to.contain('<i class="fa-');
  });

  it('keeps a dropped template byte-for-byte instead of importing it', async () => {
    const provider = new MemoryFileSystemProvider('template-drop', 'Drop');
    const result = await importDroppedFiles(
      [new File([TEMPLATE], 'post.html', { type: 'text/html' })],
      provider,
    );
    expect(result.failed).to.deep.equal([]);
    expect(await provider.readFile('post.html')).to.equal(TEMPLATE);
    expect(await provider.exists('post_files')).to.equal(false);
  });
});
