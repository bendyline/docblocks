/**
 * Where visual baselines are captured, and how the browser is told to render.
 *
 * Shared by every Playwright config that declares a visual project, so the
 * capture platform and the render settings cannot drift apart between them.
 * Deliberately free of Node-only imports: the VS Code suite loads its config
 * through a CommonJS transform, where `import.meta` is not available.
 */

/**
 * The one platform whose baselines are committed.
 *
 * macOS, because that is where the team captures and reviews them, and because
 * GitHub's `macos-latest` runners are the same major version and architecture
 * as the machines doing the reviewing — so the image a developer approves is
 * the image CI compares. A baseline captured on one platform and compared on
 * another cannot work: identical font *files* still rasterise differently
 * through CoreText, DirectWrite and FreeType, which the bundled chrome face
 * narrows but does not remove.
 *
 * Changing this means recapturing every baseline on the new platform and
 * pointing the visual workflow's runner at it.
 */
export const BASELINE_PLATFORM = 'darwin';

/** Whether this host compares pixels, as opposed to only running the specs. */
export function comparesBaselines(): boolean {
  return process.platform === BASELINE_PLATFORM || process.env.DOCBLOCKS_VISUAL_COMPARE === '1';
}

/** Whether the visual projects are declared for this run at all. */
export function visualProjectsEnabled(): boolean {
  return process.env.DOCBLOCKS_VISUAL === '1';
}

/**
 * Chromium flags that take host-specific text rendering out of the comparison.
 *
 * Hinting, subpixel positioning and LCD filtering are all resolved from the
 * host's font stack and display settings, and each one moves glyph pixels
 * without any change to the page. Turning them off does not make a macOS
 * baseline match a Linux one, but it removes the differences that vary *within*
 * a platform — display scaling, OS point releases, a runner with no attached
 * display — which is what makes a committed baseline survive more than a week.
 */
export const DETERMINISTIC_TEXT_ARGS: readonly string[] = [
  '--font-render-hinting=none',
  '--disable-font-subpixel-positioning',
  '--disable-lcd-text',
];
