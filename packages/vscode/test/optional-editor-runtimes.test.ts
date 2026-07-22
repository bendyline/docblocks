import { expect } from 'chai';
import { markdownUsesMonacoWidget } from '../webview/src/optionalEditorRuntimes.js';

describe('VS Code optional editor runtimes', () => {
  it('keeps Monaco idle for ordinary Markdown and unlabelled fences', () => {
    expect(markdownUsesMonacoWidget('# Heading\n\nParagraph.')).to.equal(false);
    expect(markdownUsesMonacoWidget('```\nplain text\n```')).to.equal(false);
  });

  it('keeps Monaco idle for fences owned by dedicated renderers', () => {
    for (const language of ['text', 'ascii', 'diagram', 'tree', 'timeline', 'mermaid']) {
      expect(markdownUsesMonacoWidget(`\`\`\`${language}\ncontent\n\`\`\``), language).to.equal(
        false,
      );
    }
  });

  it('detects explicit-language code fences handled by Monaco', () => {
    expect(markdownUsesMonacoWidget('```ts\nconst answer = 42;\n```')).to.equal(true);
    expect(markdownUsesMonacoWidget('  ~~~~python title="Example"\nprint("hi")\n~~~~')).to.equal(
      true,
    );
    expect(markdownUsesMonacoWidget('```custom-language\nvalue\n```')).to.equal(true);
  });
});
