/**
 * Drawn-list guidance shared by the server instructions, the focused
 * authoring context, prompts, and the authoring guide.
 *
 * convert_document draws a list as a picture of how its items relate (a
 * process, a cycle, key numbers, a funnel…) when the heading and the items
 * say so. An agent that knows the rule gets drawn slides from plain Markdown,
 * with no annotation to get wrong. The rule and its worked examples are the
 * linked Squisq's (`markdownShapeGuide`), where a test holds each example to
 * the classifier that applies it, so this module only chooses where to say it.
 */

/**
 * One sentence for the server instructions every client receives. Built
 * without loading Squisq, so it is fixed text; `mcp-shape-guidance.test.ts`
 * holds it to the linked guide.
 */
export const SHAPE_INSTRUCTION_GUIDANCE =
  'A slide whose body is one list of 2–6 short items is drawn as a picture of how they relate: a numbered list as steps, `Label: detail` items as cards, `Figure: what it measures` items as key numbers, and other shapes by what the heading says. get_authoring_context says what decides each picture.';

/** The rule in one paragraph, for the focused authoring context and prompts. */
export async function shapeSelectionGuidance(): Promise<string> {
  const { markdownShapeSummary } = await import('@bendyline/squisq/doc');
  return markdownShapeSummary();
}

/** The complete drawn-list section of `docblocks://authoring-guide`. */
export async function authoringGuideShapes() {
  const { CONCEPT_SPECS, conceptItemCount, markdownShapeExample, markdownShapeGuide } =
    await import('@bendyline/squisq/doc');
  const templates = Object.keys(CONCEPT_SPECS) as Array<keyof typeof CONCEPT_SPECS>;
  return {
    guide: markdownShapeGuide(),
    templates: templates.map((id) => ({
      id,
      items: conceptItemCount(id),
      order: CONCEPT_SPECS[id].order ?? null,
      // One level-one heading is one slide, so the example is a whole slide.
      example: markdownShapeExample(id, { headingLevel: 1 }),
    })),
    check:
      'inspect_document reports an annotated block whose items its template cannot draw (template-shape-unmet), for example {[matrix]} over three items; recommend_templates returns each list-only block’s listShape, the reading convert_document acts on.',
  };
}

/** A concept template's worked example as one slide, or null for any other template. */
export async function shapeAnnotationExample(templateId: string): Promise<string | null> {
  const { CONCEPT_SPECS, markdownShapeExample } = await import('@bendyline/squisq/doc');
  return Object.prototype.hasOwnProperty.call(CONCEPT_SPECS, templateId)
    ? markdownShapeExample(templateId as keyof typeof CONCEPT_SPECS, { headingLevel: 1 })
    : null;
}
