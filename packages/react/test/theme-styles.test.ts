import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';

const styles = readFileSync(
  fileURLToPath(new URL('../src/styles/docblocks.css', import.meta.url)),
  'utf8',
);

describe('appearance styles', () => {
  it('uses the selected accent for horizontal rules in the write canvas', () => {
    expect(styles).to.match(
      /\.db-shell\s+\.squisq-editor-shell\s+\.squisq-wysiwyg-editor\s+hr\s*\{[^}]*border-top-color:\s*var\(--db-accent\);/s,
    );
  });

  it('themes the first Source-view frame while Monaco loads', () => {
    expect(styles).to.match(
      /\.db-shell\s+\.squisq-editor-shell\s*\{[^}]*--squisq-editor-background:\s*#ffffff;[^}]*--squisq-editor-foreground:\s*#1f2937;/s,
    );
    expect(styles).to.match(
      /\.db-shell\s+\.squisq-editor-shell\[data-theme='dark'\]\s*\{[^}]*--squisq-editor-background:\s*#1e1e1e;[^}]*--squisq-editor-foreground:\s*#d4d4d4;/s,
    );
  });

  it('gives an explicit Write-canvas font choice precedence over theme fonts', () => {
    expect(styles).to.match(
      /\.db-shell\s+\.squisq-editor-shell\s+\.squisq-wysiwyg-editor\s*\{[^}]*font-family:\s*var\(--squisq-write-body-font,\s*var\(--squisq-theme-body-font,\s*inherit\)\);/s,
    );
    expect(styles).to.match(
      /\.db-shell\s+\.squisq-editor-shell\s+\.squisq-wysiwyg-editor\s+h1,[^{]+\{\s*font-family:\s*var\(\s*--squisq-write-header-font,\s*var\(\s*--squisq-write-body-font,\s*var\(--squisq-theme-title-font,\s*var\(--squisq-theme-body-font,\s*inherit\)\)\s*\)\s*\);/s,
    );
  });

  it('uses the selected accent for the file-list scrollbar', () => {
    expect(styles).to.match(
      /\.db-tree\s*\{[^}]*scrollbar-color:\s*var\(--db-accent\)\s+var\(--db-bg\);/s,
    );
    expect(styles).to.match(
      /\.db-tree::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--db-accent\);/s,
    );
  });

  it('themes the segmented mode toolbar with the selected DocBlocks accent', () => {
    expect(styles).to.match(
      /\.db-shell\s+\.squisq-editor-shell\s+\.squisq-preview-seg\s*\{[^}]*background:\s*var\(--db-bg\);[^}]*border-color:\s*var\(--db-border\);/s,
    );
    expect(styles).to.match(
      /\.db-shell\s+\.squisq-editor-shell\s+\.squisq-preview-seg-btn--active\s*\{[^}]*background:\s*var\(--db-accent\);[^}]*color:\s*var\(--db-text-on-accent\);/s,
    );
    expect(styles).to.match(
      /\.db-shell\s+\.squisq-editor-shell\s+\.squisq-preview-seg-btn--active:hover\s*\{[^}]*background:\s*var\(--db-accent-hover\);/s,
    );
    expect(styles).to.match(
      /\.db-shell\s+\.squisq-editor-shell\s+\.squisq-preview-seg-btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--db-focus,\s*var\(--db-accent\)\);/s,
    );
  });
});
