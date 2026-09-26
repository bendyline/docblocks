import { expect } from 'chai';
import {
  DB_BREAKPOINTS,
  SPLIT_PANE_MIN_WIDTH,
  classifyFormFactor,
  classifyWidth,
  formFactorDataAttributes,
  resolveLayoutMode,
  type DbFormFactor,
  type DbLayoutMode,
  type DbPointer,
  type DbSidebarPreference,
  type DbWidthClass,
  type FormFactorInput,
} from '../src/layout/form-factor.js';
import { SIDEBAR_WIDTH_MIN } from '../src/DocBlocksShell/shell-preferences.js';

function input(overrides: Partial<FormFactorInput> = {}): FormFactorInput {
  return {
    width: 1280,
    height: 800,
    pointer: 'fine',
    hover: 'hover',
    installed: false,
    ...overrides,
  };
}

describe('form factor classification', () => {
  describe('classifyWidth boundaries', () => {
    const cases: ReadonlyArray<readonly [number, DbWidthClass]> = [
      [320, 'compact'],
      [719, 'compact'],
      [720, 'compact'],
      [721, 'medium'],
      [1023, 'medium'],
      [1024, 'expanded'],
      [1439, 'expanded'],
      [1440, 'wide'],
      [2560, 'wide'],
    ];

    for (const [width, expected] of cases) {
      it(`classifies ${width}px as ${expected}`, () => {
        expect(classifyWidth(width)).to.equal(expected);
      });
    }

    it('keeps every boundary aligned with the published breakpoints', () => {
      expect(classifyWidth(DB_BREAKPOINTS.compactMax)).to.equal('compact');
      expect(classifyWidth(DB_BREAKPOINTS.compactMax + 1)).to.equal('medium');
      expect(classifyWidth(DB_BREAKPOINTS.mediumMax)).to.equal('medium');
      expect(classifyWidth(DB_BREAKPOINTS.mediumMax + 1)).to.equal('expanded');
      expect(classifyWidth(DB_BREAKPOINTS.expandedMax)).to.equal('expanded');
      expect(classifyWidth(DB_BREAKPOINTS.expandedMax + 1)).to.equal('wide');
    });
  });

  describe('form factor is width AND input modality, never width alone', () => {
    const cases: ReadonlyArray<readonly [string, Partial<FormFactorInput>, DbFormFactor]> = [
      ['phone portrait', { width: 390, height: 844, pointer: 'coarse' }, 'phone'],
      // A phone turned sideways is `medium` by width but still a phone: the
      // short edge, not the long one, is what separates the two device classes.
      ['phone landscape', { width: 844, height: 390, pointer: 'coarse' }, 'phone'],
      ['iPad portrait', { width: 834, height: 1194, pointer: 'coarse' }, 'tablet-portrait'],
      ['iPad landscape', { width: 1194, height: 834, pointer: 'coarse' }, 'tablet-landscape'],
      // A narrow desktop window is compact but emphatically not a phone.
      ['narrow desktop window', { width: 500, height: 900, pointer: 'fine' }, 'desktop'],
      ['wide desktop', { width: 1920, height: 1080, pointer: 'fine' }, 'desktop'],
    ];

    for (const [name, overrides, expected] of cases) {
      it(`treats ${name} as ${expected}`, () => {
        expect(classifyFormFactor(input(overrides)).formFactor).to.equal(expected);
      });
    }

    it('reports orientation from the measured box, squares counting as portrait', () => {
      expect(classifyFormFactor(input({ width: 800, height: 800 })).orientation).to.equal(
        'portrait',
      );
      expect(classifyFormFactor(input({ width: 801, height: 800 })).orientation).to.equal(
        'landscape',
      );
    });

    it('keeps a coarse pointer with hover distinguishable from a fine pointer', () => {
      // An iPad with a Magic Keyboard reports BOTH. It must keep 44px targets
      // (coarse) while regaining hover-reveal affordances (any-hover: hover).
      const ipadWithKeyboard = classifyFormFactor(
        input({ width: 1194, height: 834, pointer: 'coarse', hover: 'hover' }),
      );
      expect(ipadWithKeyboard.formFactor).to.equal('tablet-landscape');
      expect(ipadWithKeyboard.pointer).to.equal('coarse');
      expect(ipadWithKeyboard.hover).to.equal('hover');
    });
  });

  describe('splitPaneAllowed', () => {
    it('derives from the sidebar minimum plus a usable editor pane', () => {
      expect(SPLIT_PANE_MIN_WIDTH).to.equal(SIDEBAR_WIDTH_MIN + 480);
      expect(SPLIT_PANE_MIN_WIDTH).to.equal(800);
    });

    it('is false below the threshold and true at it', () => {
      expect(classifyFormFactor(input({ width: 799 })).splitPaneAllowed).to.equal(false);
      expect(classifyFormFactor(input({ width: 800 })).splitPaneAllowed).to.equal(true);
    });
  });

  describe('resolveLayoutMode', () => {
    const layout = (
      overrides: Partial<FormFactorInput>,
      preference: DbSidebarPreference,
    ): DbLayoutMode => resolveLayoutMode(classifyFormFactor(input(overrides)), preference);

    it('never splits a viewport too narrow to hold both panes', () => {
      for (const preference of ['auto', 'pinned', 'collapsed'] as const) {
        expect(layout({ width: 799, pointer: 'fine' }, preference)).to.equal('single-pane');
        expect(layout({ width: 390, pointer: 'coarse' }, preference)).to.equal('single-pane');
      }
    });

    it('honours an explicit preference above the threshold', () => {
      expect(layout({ width: 1920 }, 'collapsed')).to.equal('single-pane');
      expect(layout({ width: 834, pointer: 'coarse' }, 'pinned')).to.equal('split-pane');
    });

    it('splits at expanded and wide regardless of pointer', () => {
      for (const pointer of ['fine', 'coarse'] as const satisfies readonly DbPointer[]) {
        expect(layout({ width: 1194, height: 834, pointer }, 'auto')).to.equal('split-pane');
        expect(layout({ width: 1920, height: 1080, pointer }, 'auto')).to.equal('split-pane');
      }
    });

    it('splits the 800-1023 band only for a fine pointer', () => {
      // Preserves today's desktop behaviour at 900px...
      expect(layout({ width: 900, height: 700, pointer: 'fine' }, 'auto')).to.equal('split-pane');
      // ...while an iPad in portrait gets the overlay drawer and touch targets.
      expect(layout({ width: 834, height: 1194, pointer: 'coarse' }, 'auto')).to.equal(
        'single-pane',
      );
    });
  });

  describe('formFactorDataAttributes', () => {
    it('emits exactly the attribute contract the stylesheet keys off', () => {
      const formFactor = classifyFormFactor(
        input({ width: 390, height: 844, pointer: 'coarse', hover: 'none' }),
      );
      expect(formFactorDataAttributes(formFactor, 'single-pane')).to.deep.equal({
        'data-db-width': 'compact',
        'data-db-form-factor': 'phone',
        'data-db-pointer': 'coarse',
        'data-db-hover': 'none',
        'data-db-orientation': 'portrait',
        'data-db-layout': 'single-pane',
      });
    });
  });
});
