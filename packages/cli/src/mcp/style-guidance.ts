export const STYLE_SELECTION_GUIDANCE =
  'Choose theme and Squisq Summarize/transform style automatically from the user brief, audience, tone, content shape, brand constraints, and accessibility needs. Do not present raw theme/transform ids to the user or ask separate theme, summarization, animation, and template questions. If the choice is materially ambiguous and interactive clarification is available, ask one concise high-level preference question with at most four semantic directions plus a "choose for me" option; otherwise use safe defaults and proceed.';

export const TRANSFORM_SELECTION_GUIDANCE =
  "Treat transformId as the Squisq Summarize control: it can change content emphasis, density, pacing, and structure. For an existing source whose exact language or coverage matters, leave transformId unset unless the user requests or permits summarization or visual restructuring. When transformId is selected and the user did not request an exact theme, omit themeId so Squisq can apply that transform style's preferred compatible theme.";

export const MOTION_SELECTION_GUIDANCE =
  'Treat motion as a high-level none, subtle, or dynamic preference instead of listing individual transitions. Themes provide motion defaults; use animationsEnabled only to honor an explicit MP4 or GIF motion preference.';
