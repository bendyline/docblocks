import { expect } from 'chai';
import {
  describeOrigin,
  describeVersion,
  describeVersionCount,
  describeVersionSource,
  keptVersionFileName,
} from '../src/DocBlocksShell/document-versions.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

describe('stored document version wording', () => {
  it('says where each kind of version came from', () => {
    expect(describeVersionSource({ origin: 'sync', label: "Mike's MacBook Pro" })).to.equal(
      "Saved on Mike's MacBook Pro",
    );
    expect(describeVersionSource({ origin: 'sync', label: null })).to.equal(
      'Saved on another device',
    );
    // The copy syncs with the folder, so it never claims to be from "this device".
    expect(describeVersionSource({ origin: 'local', label: null })).to.equal(
      'Edits that were set aside',
    );
    // A version from another device that the user chose not to combine.
    expect(describeVersionSource({ origin: 'local', label: "Mike's MacBook Pro" })).to.equal(
      "Edits from Mike's MacBook Pro that were set aside",
    );
    // Both sides of a merge are kept, and each says whose it was.
    expect(describeVersionSource({ origin: 'premerge', label: null })).to.equal(
      'Your text from before edits were combined',
    );
    expect(describeVersionSource({ origin: 'premerge', label: 'iPad' })).to.equal(
      'The version from iPad, before edits were combined',
    );
    expect(describeVersionSource({ origin: 'draft', label: null })).to.equal(
      'A recovered draft that was set aside',
    );
  });

  it('adds a plain age, and leaves out one a wrong clock would make nonsense', () => {
    const copy = { origin: 'sync' as const, label: 'iPad' };
    expect(describeVersion({ ...copy, capturedAt: NOW - 3 * 60_000 }, NOW)).to.equal(
      'Saved on iPad, 3 minutes ago',
    );
    expect(describeVersion({ ...copy, capturedAt: NOW + 3_600_000 }, NOW)).to.equal(
      'Saved on iPad',
    );
  });

  it('counts versions in words', () => {
    expect(describeVersionCount(1)).to.equal('1 other version to review');
    expect(describeVersionCount(3)).to.equal('3 other versions to review');
  });

  it('names who changed a document, or says it was another device', () => {
    expect(describeOrigin({ savedBy: "Mike's iPhone" })).to.equal("Mike's iPhone");
    expect(describeOrigin({ savedBy: '  ' })).to.equal('another device');
    expect(describeOrigin(undefined)).to.equal('another device');
  });

  it('names a version kept as its own document without taking an existing name', () => {
    const none = new Set<string>();
    expect(keptVersionFileName('Unicorns.md', { label: "Mike's MacBook Pro" }, none)).to.equal(
      "Unicorns (from Mike's MacBook Pro).md",
    );
    expect(keptVersionFileName('Unicorns.md', { label: null }, none)).to.equal(
      'Unicorns (other version).md',
    );
    expect(
      keptVersionFileName(
        'Unicorns.md',
        { label: null },
        new Set(['unicorns (OTHER version).md', 'Unicorns (other version) 2.md']),
      ),
    ).to.equal('Unicorns (other version) 3.md');
    expect(keptVersionFileName('README', { label: 'iPad' }, none)).to.equal('README (from iPad)');
  });
});
