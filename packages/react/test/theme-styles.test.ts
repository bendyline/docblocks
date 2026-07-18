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

  it('uses the selected accent for the file-list scrollbar', () => {
    expect(styles).to.match(
      /\.db-tree\s*\{[^}]*scrollbar-color:\s*var\(--db-accent\)\s+var\(--db-bg\);/s,
    );
    expect(styles).to.match(
      /\.db-tree::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--db-accent\);/s,
    );
  });
});
