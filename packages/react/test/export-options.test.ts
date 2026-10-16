/**
 * Tests for export-options — pure tables (FORMAT_LABELS / FORMAT_EXTENSIONS),
 * DEFAULT_OPTIONS shape, and localStorage round-trip.
 *
 * The persistence functions must survive corrupt/missing storage values
 * (they wrap parse + storage access in try/catch) — verify both branches.
 */
import { expect } from 'chai';
import {
  DEFAULT_OPTIONS,
  FORMAT_EXTENSIONS,
  exportThemeChoices,
  FORMAT_LABELS,
  loadLastExportOptions,
  saveExportOptions,
  type ExportFormat,
  type ExportOptions,
} from '../src/Export/export-options.js';
import { exporterThemeId } from '../src/Export/run-export.js';

const ALL_FORMATS: ExportFormat[] = ['docx', 'pdf', 'pptx', 'epub', 'md', 'html'];
const STORAGE_KEY = 'docblocks-export-options';

describe('export-options', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('FORMAT_LABELS', () => {
    it('has a label for every ExportFormat', () => {
      for (const fmt of ALL_FORMATS) {
        expect(FORMAT_LABELS[fmt]).to.be.a('string').and.have.length.greaterThan(0);
      }
    });
  });

  describe('FORMAT_EXTENSIONS', () => {
    it('returns an extension matching the format for every value', () => {
      expect(FORMAT_EXTENSIONS.docx).to.equal('.docx');
      expect(FORMAT_EXTENSIONS.pdf).to.equal('.pdf');
      expect(FORMAT_EXTENSIONS.pptx).to.equal('.pptx');
      expect(FORMAT_EXTENSIONS.epub).to.equal('.epub');
      expect(FORMAT_EXTENSIONS.md).to.equal('.md');
      expect(FORMAT_EXTENSIONS.html).to.equal('.html');
    });

    it('every extension starts with a dot', () => {
      for (const fmt of ALL_FORMATS) {
        expect(FORMAT_EXTENSIONS[fmt].startsWith('.')).to.equal(true);
      }
    });
  });

  describe('DEFAULT_OPTIONS', () => {
    it('is a complete ExportOptions object (every field populated)', () => {
      const required: (keyof ExportOptions)[] = [
        'format',
        'themeId',
        'transformStyle',
        'pageSize',
        'htmlStyle',
        'htmlBundle',
        'includeLinkedDocs',
        'entryAsIndex',
      ];
      for (const key of required) {
        expect(DEFAULT_OPTIONS).to.have.property(key);
      }
    });

    it('uses safe defaults that do not depend on a workspace state', () => {
      expect(DEFAULT_OPTIONS.format).to.equal('pdf');
      expect(DEFAULT_OPTIONS.includeLinkedDocs).to.equal(false);
      expect(DEFAULT_OPTIONS.entryAsIndex).to.equal(false);
    });
  });

  describe('saveExportOptions / loadLastExportOptions', () => {
    it('round-trips every field', () => {
      const original: ExportOptions = {
        format: 'pptx',
        themeId: 'custom',
        transformStyle: 'slideshow',
        pageSize: 'a4',
        htmlStyle: 'rendered',
        htmlBundle: 'zip',
        includeLinkedDocs: true,
        entryAsIndex: true,
      };
      saveExportOptions(original);
      const restored = loadLastExportOptions();
      expect(restored).to.deep.equal(original);
    });

    it('returns null when nothing has been saved', () => {
      expect(loadLastExportOptions()).to.equal(null);
    });

    it('returns null on corrupt JSON (does not throw)', () => {
      localStorage.setItem(STORAGE_KEY, '{not valid json');
      expect(loadLastExportOptions()).to.equal(null);
    });

    it('back-fills missing fields from DEFAULT_OPTIONS on partial save', () => {
      // Simulate an older version that stored only some fields.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ format: 'docx', themeId: 'old' }));
      const restored = loadLastExportOptions();
      expect(restored).to.not.equal(null);
      // Saved fields kept
      expect(restored!.format).to.equal('docx');
      expect(restored!.themeId).to.equal('old');
      // Missing fields come from DEFAULT_OPTIONS
      expect(restored!.pageSize).to.equal(DEFAULT_OPTIONS.pageSize);
      expect(restored!.htmlStyle).to.equal(DEFAULT_OPTIONS.htmlStyle);
      expect(restored!.includeLinkedDocs).to.equal(DEFAULT_OPTIONS.includeLinkedDocs);
    });
  });

  describe('exportThemeChoices', () => {
    it('lists the document themes first and lets them shadow a built-in id', () => {
      const choices = exportThemeChoices([
        { id: 'acme', name: 'Acme Brand' },
        { id: 'warm-earth', name: 'Our Warm Earth' },
      ]);
      expect(choices.slice(0, 2).map((theme) => theme.name)).to.deep.equal([
        'Acme Brand',
        'Our Warm Earth',
      ]);
      expect(choices.filter((theme) => theme.id === 'warm-earth')).to.have.length(1);
      expect(choices.some((theme) => theme.id === 'standard')).to.equal(true);
    });
  });

  describe('exporterThemeId', () => {
    it('passes a chosen theme through', () => {
      expect(exporterThemeId('# Plain', 'documentary')).to.equal('documentary');
    });

    it('leaves Standard implicit for a document that names no theme', () => {
      expect(exporterThemeId('# Plain', 'standard')).to.equal(undefined);
      expect(exporterThemeId('---\ntitle: Notes\n---\n\n# Plain', 'standard')).to.equal(undefined);
    });

    it('makes Standard explicit when it overrides the document theme', () => {
      // Exporters given no theme fall back to the frontmatter one, so an
      // implicit Standard would silently export in Warm Earth.
      const themed = '---\nsquisq-theme: warm-earth\n---\n\n# Themed';
      expect(exporterThemeId(themed, 'standard')).to.equal('standard');
    });
  });
});
