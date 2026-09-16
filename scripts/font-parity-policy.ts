/**
 * Which webfont families each editor surface must declare.
 *
 * Squisq's `AVAILABLE_FONT_STACKS` registry is the contract: a stack that names
 * a `googleFontFamily` expects the *host page* to supply the matching
 * `@font-face` rules — Squisq ships none itself. A surface that mounts the
 * editor without them renders that stack in its fallback face (Georgia, or a
 * system sans) with no error, on any document that selects it.
 *
 * That is a silent visual defect, which is why it is checked here as bytes
 * rather than left to a screenshot: it is deterministic, and far cheaper.
 */

/** A surface's declared faces, parsed from its stylesheet. */
export interface SurfaceFonts {
  /** Name used in failure messages. */
  readonly surface: string;
  /** Stylesheet the families were read from, repo-relative. */
  readonly source: string;
  readonly families: ReadonlySet<string>;
}

export interface FontParityViolation {
  readonly surface: string;
  readonly source: string;
  readonly missing: readonly string[];
}

/**
 * Read every `font-family` declared by an `@font-face` rule.
 *
 * Only `@font-face` blocks count: a `font-family` inside an ordinary rule names
 * a face to *use*, not one the surface supplies.
 */
export function declaredFontFaceFamilies(css: string): ReadonlySet<string> {
  const families = new Set<string>();
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gu)) {
    const declaration = /font-family\s*:\s*([^;]+)/u.exec(block[1] ?? '');
    if (!declaration) continue;
    families.add(declaration[1]!.trim().replace(/^['"]|['"]$/gu, ''));
  }
  return families;
}

/**
 * Families a host must supply for Squisq's registry to render as authored.
 * A stack with no `googleFontFamily` is a system stack and needs nothing.
 */
export function requiredFamilies(
  fontStacks: readonly { readonly googleFontFamily?: string }[],
): readonly string[] {
  return [
    ...new Set(
      fontStacks
        .map((stack) => stack.googleFontFamily)
        .filter((family): family is string => typeof family === 'string' && family.length > 0),
    ),
  ].sort();
}

export function fontParityViolations(
  required: readonly string[],
  surfaces: readonly SurfaceFonts[],
  exemptions: Readonly<Record<string, readonly string[]>> = {},
): readonly FontParityViolation[] {
  const violations: FontParityViolation[] = [];
  for (const surface of surfaces) {
    const exempt = new Set(exemptions[surface.surface] ?? []);
    const missing = required.filter(
      (family) => !surface.families.has(family) && !exempt.has(family),
    );
    if (missing.length > 0) {
      violations.push({ surface: surface.surface, source: surface.source, missing });
    }
  }
  return violations;
}
