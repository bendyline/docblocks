/**
 * Picture authoring guidance shared by the authoring guide, the focused
 * authoring context, prompts, and server instructions.
 *
 * Every rule restates linked Squisq behavior: a ```svg fence becomes a
 * sanitized SVG island, the Markdown sanitizer drops raw `<svg>` HTML, and the
 * Node-side converters have no diagram renderer, so Mermaid exports as its
 * source text and semantic PDF prints every picture fence as source. The
 * preview player draws SVG, timeline, tree, and chart pictures but omits
 * Mermaid. Revisit these strings whenever that Squisq behavior changes.
 */

/** Compact picture rules for the focused authoring context. */
export const PICTURE_SELECTION_GUIDANCE =
  'Pictures: ```mermaid for flows, sequences, states, hierarchies, gantt; ```timeline for dated events; ```tree for outlines; a table under `## Sales {[barChart]}` for numbers; ```svg for bespoke illustrations, icons, annotated figures. In ```svg: one <svg> root with a viewBox and <title>, currentColor strokes and text, font-family="sans-serif"; no script, foreignObject, event handlers, external links or web fonts. Never raw <svg> HTML (silently dropped); use ```xml to show SVG source. inspect_document flags broken ```svg.';

/** One-sentence picture rule for the server instructions every client receives. */
export const PICTURE_INSTRUCTION_GUIDANCE =
  'Draw pictures with fences, never raw <svg> HTML, which is silently dropped: ```svg for bespoke art, ```mermaid, ```timeline, ```tree, or a chart template over a table. get_authoring_context gives target-specific picture rules.';

/** The SVG fence rules repeated in prompts. */
const SVG_FENCE_SUMMARY =
  'a ```svg fence (one <svg> root with a viewBox, a <title>, and currentColor strokes and text)';

/**
 * How the Node-side converters treat picture fences for one export target, or
 * null when every picture format survives (or the target is unknown).
 */
export function pictureExportGuidance(targetFormat: string | null): string | null {
  switch (targetFormat) {
    case 'pptx':
      return 'PPTX exports Mermaid as source text; draw flows as ```svg. Other pictures draw.';
    case 'docx':
    case 'epub':
      return 'In DOCX and EPUB only ```svg becomes a picture; Mermaid, timeline and tree fences export as source text, so draw pictures that must survive as ```svg.';
    case 'pdf':
      return 'Semantic PDF prints every picture fence as source text. Use fidelity "rendered-fidelity" only when pictures matter more than selectable text; Mermaid still does not draw there.';
    default:
      return null;
  }
}

/** Short picture hint for the create-presentation prompt. */
export const PRESENTATION_PICTURE_HINT = `For pictures use ${SVG_FENCE_SUMMARY}, \`\`\`timeline, \`\`\`tree, or a chart template over a table; Mermaid exports to PPTX as source text, and raw <svg> HTML is silently dropped.`;

/** Short picture hint for the create-document prompt. */
export function documentPictureHint(target: 'docx' | 'pdf'): string {
  return target === 'docx'
    ? `For pictures use ${SVG_FENCE_SUMMARY}; DOCX keeps Mermaid, timeline and tree fences as source text, and raw <svg> HTML is silently dropped.`
    : `For pictures use ${SVG_FENCE_SUMMARY}; raw <svg> HTML is silently dropped. Semantic PDF prints picture fences as source text, so pass fidelity "rendered-fidelity" when pictures matter more than selectable text.`;
}

/** A complete, theme-following island used as the guide's worked example. */
export const SVG_ISLAND_EXAMPLE = [
  '```svg',
  '<svg viewBox="0 0 320 120" xmlns="http://www.w3.org/2000/svg">',
  '  <title>A request flows from the client to the server</title>',
  '  <rect x="10" y="30" width="110" height="60" rx="8" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-width="2"/>',
  '  <text x="65" y="66" font-family="sans-serif" font-size="16" text-anchor="middle" fill="currentColor">Client</text>',
  '  <path d="M124 60 H188" fill="none" stroke="currentColor" stroke-width="2"/>',
  '  <path d="M188 52 L200 60 L188 68 Z" fill="currentColor"/>',
  '  <rect x="200" y="30" width="110" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>',
  '  <text x="255" y="66" font-family="sans-serif" font-size="16" text-anchor="middle" fill="currentColor">Server</text>',
  '</svg>',
  '```',
].join('\n');

/** The complete picture section of `docblocks://authoring-guide`. */
export async function authoringGuidePictures() {
  const [{ SVG_ISLAND_LIMITS }, { TABLE_FED_TEMPLATES, getAvailableTemplates }] = await Promise.all(
    [import('@bendyline/squisq/markdown'), import('@bendyline/squisq/doc')],
  );
  const available = new Set(getAvailableTemplates());
  const chartTemplates = [...TABLE_FED_TEMPLATES].filter(
    (id) => id !== 'dataTable' && available.has(id),
  );
  const sourceKiB = Math.floor(SVG_ISLAND_LIMITS.maxSourceBytes / 1024);
  return {
    choose: [
      '```mermaid for flows, sequences, state machines, hierarchies, and gantt schedules.',
      '```timeline for dated events: one rail per track, for example `● 2020 Founded ───● 2022 Launch ───►`.',
      '```tree for outlines and file trees drawn with ├── and └── branches.',
      'A Markdown table under a heading annotated with a chart template for numbers, for example `## Revenue {[barChart]}`. Every chart template reads the first table in its block.',
      '```svg for bespoke illustrations, icons, annotated figures, and anything the formats above cannot draw.',
      'A sidecar `![alt](assets/name.svg)` image only for large or reused artwork. Pass it as a bundle asset, or stage it with create_document_bundle, so it travels with the document. Sidecar SVG is sanitized like a fence but keeps its own colors.',
      'The diagram, drawing, and layout container templates build pictures from child headings; use describe_template for their inputs.',
    ],
    chartTemplates,
    svgRules: [
      'Exactly one <svg> root with a viewBox, for example viewBox="0 0 640 360", and nothing beside it.',
      'A <title> as the first child: it becomes the alt text. A root aria-label also works.',
      'currentColor for strokes and text, and fill="none" or currentColor with fill-opacity, instead of hard-coded black or white. Fences then follow the theme text color on screen, in slides, DOCX, and EPUB. Accent colors are fine, but nothing inside the picture follows dark mode or CSS variables.',
      'No script, foreignObject, on* event handlers, external href or xlink:href links and images, url() other than url(#id), @import, or @font-face web fonts: the sanitizer removes them. <image> accepts only base64 PNG, JPEG, GIF, or WebP data URIs.',
      'font-family="sans-serif": pictures render with system fonts, never the page or theme fonts. Keep labels short and keep all text inside the viewBox.',
      `Stay well under the limits: ${sourceKiB} KiB of source, ${SVG_ISLAND_LIMITS.maxElements} elements, nesting depth ${SVG_ISLAND_LIMITS.maxDepth}, and ${SVG_ISLAND_LIMITS.maxExpandedElements} elements after <use> expansion. A fence past any limit shows as code.`,
    ],
    svgExample: SVG_ISLAND_EXAMPLE,
    never:
      'Never write raw <svg> HTML in Markdown: the sanitizer silently drops it with its content. Use a ```svg fence to draw it, or an ```xml fence to show SVG source as code.',
    exports: [
      'convert_document embeds ```svg as a vector picture in DOCX, PPTX, EPUB, and HTML.',
      'PPTX also draws timeline, tree, and chart pictures as native shapes.',
      'Mermaid exports as source text in DOCX, PPTX, EPUB, and PDF; timeline and tree fences do too in DOCX, EPUB, and PDF. Draw a picture that must survive those exports as ```svg.',
      'Semantic PDF prints every picture fence as source text. Rendered-fidelity PDF draws ```svg, timeline, tree, and chart pictures, but not Mermaid.',
    ],
    check:
      'inspect_document reports a ```svg fence that will not draw (svg-fence-not-rendered), content the sanitizer removed (svg-content-removed), a missing <title> (svg-missing-title), and raw <svg> HTML (raw-svg-html-dropped). preview_document draws ```svg, timeline, tree, and chart pictures, or a dashed "Couldn\'t render this SVG" placeholder for a broken fence; Mermaid shows a placeholder there.',
  };
}
