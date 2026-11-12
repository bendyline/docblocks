# Dynamic slides and the Summarization designer

Choose **Slideshow** or **Video**, then click **Design…** beside the **Summarize**
dropdown. On a narrower toolbar, open **… (More preview settings)** to find both
controls. The designer is available in DocBlocksShell and the VS Code editor. It is no longer a writing-toolbar action.
You can also select **Dynamic slides** directly from **Summarize**.

Your document text, inline block tags, and narration stay unchanged. Squisq
regenerates slides from the current prose and saved preferences at preview and
export time. Automatic summaries are never saved as generated prose. The designer
shows the full original section read-only alongside the current slide preview.
That source text stays the same when layouts split or merge supporting slides,
and the selection follows the source passage rather than its slide number.

Use the **Left** and **Right** arrow keys to move between slides. Navigation stops
at the first and last slides and keeps the selected slide visible in the list.
Text fields and dropdowns retain their normal arrow-key behavior.

For PowerPoint exports, choose **Transform → None** in the export dialog to use
the document's content and slide layouts without summarization. This overrides
saved presentation settings for that export without changing the document.

Choose a summary density, a preferred layout per section, and whether to add
supporting visual slides (on by default). **One slide per section** makes exactly
one summary slide for each section, timed to that section's narration, however
long the section is; it never adds supporting slides. A section can override the document-wide preference
with **Allow** or **Do not add**. A supporting slide is added only when it shows
something different from the slide before it: an introduction followed by a
diagram of the sentences that open with First / Then / Next / Finally, or the
opening sentences of a passage followed by the document image that illustrates
it. They share that passage's narration interval; they do not add spoken filler
or extend the take. Layout preferences apply where the source has enough
material for that layout.

The summary layouts are Title, Section break, Statement, Big statement (only the
headline, when it is 60 characters or fewer), Quote (one sentence of the section,
word for word), Key number (a prominent figure such as 40% or $3 million),
Definition, Points, Comparison, Steps, Picture, and the layouts that draw: Cards,
Process, Cycle, Layers, Key numbers, Pyramid, Funnel, Hub, Venn and Matrix. Squisq
names them and says what each needs (`PRESENTATION_LAYOUT_LABELS`,
`presentationLayoutNeeds`), so a layout Squisq adds appears in the designer with
its help text and no DocBlocks change. The automatic planner picks a title, cards,
a statement, steps, a cycle, a comparison, a key number, a big statement or a
picture; the section break, quote, definition and the other drawings come from a
section preference or an AI suggestion, and an AI quote or figure must appear in
the passage.

The drawing layouts show a slide's points instead of listing them: parallel ideas
as cards side by side, ordered stages as numbered steps joined by arrows, a
repeating sequence as stages on a ring, nested parts (a core and the layers around
it) as concentric rings, innermost first, several figures as key numbers that
count up, a hierarchy as a pyramid, stages that narrow as a funnel, ideas around
the one thing they share as a hub, two things and what they share as a Venn
diagram, and four ideas on two axes as a matrix. A point written `Label: detail`
sets its label in bold, and a key number is written `Figure: what it measures`. A
process whose stages each open with a date, in order, is drawn as a timeline. A
comparison of two points sets them as two panels with a "vs" mark between them. A
section a little longer than one slide stays on one slide rather than leaving a
one-sentence remainder, so a cycle keeps the sentence that closes it and a matrix
its fourth panel. Automatic slides with several
points become cards (a sentence that defines its subject, such as "Antibodies are
proteins…", is labelled by that subject); a passage whose sentences open "First…
Then… Finally…" becomes a process, kept on one slide, or a cycle when it says the
sequence repeats. Key ideas, lists, comparisons, definitions, key numbers and big
statements share the same headline lockup and type, so a deck reads as one
design: a key number sits large beside what it means, and a big statement sets in
the headline face rather than capitals.

Each card or stage appears as the narration reaches the sentence it summarizes
(the first as the headline settles); in a slideshow or the recorder, Next reveals
them in turn. With the theme's motion profile, each one assembles as it arrives:
arrows and timeline track draw on, numbered badges and rings pop, cards lift and
words rise, and a key number counts up. The designer offers the layouts the
installed Squisq supports.

A section can instead be shown **As authored**, labeled with the block type it
renders with, such as **As authored (Bar Chart)**. That section becomes one slide
for its whole narration, drawn from its own block with the template chosen in the
editor's block picker, so charts, tables, maps, and other data blocks keep their
content. It is not summarized, split into supporting slides, reworded, or sent to
AI. Change its block type in the editor.

Automatic slides are titled with their section heading and show the section's
own sentences beneath it, so a slide never repeats its title as its body. Each
document image appears once, on a slide from the section that contains it.

A section's features (its tables, its pictures, and its embedded videos and
diagrams: a `<video>`, a hosted video, a Mermaid or SVG fence, or a `diagram` /
`tree` / `timeline` fence) appear on its slides in every layout and density
rather than being dropped. The section's slides are shared out among them in
source order, so every one is shown. A table, picture, diagram or HTML video stays
on screen across consecutive slides, and the video plays on from where the
previous slide left it instead of restarting. A picture normally gets its own
image slide; when no slide shows it that way (a layout preference other than
Image, or more pictures than slides) it appears beside the slide text instead. A
slide that carries one prefers a list over a steps diagram, unless the section's
layout preference says steps. Timed clips attached to a section, such as a
`{[audio …]}` music bed, start on its first slide and stop where the section ends.

A slide that carries a feature keeps its words short so the feature has the room:
at most two points, each cut at a clause near 100 characters (points typed in
**Customize slide wording** stand as written). The words summarize the section's
prose: a table's cells and a diagram's source never become a slide's points, and
never start a slide of their own at any density. A table is drawn whole beneath
the headline and points at the slide's full width, its cells wrapping and keeping
their own line breaks, with the type set as large as every row allows. A chart
section summarized this way shows its data as a table; show it **As authored** to
draw the chart.

**Use dynamic slides** saves the preferences and selects the Dynamic slides
summarization mode in one undoable edit. It also disables the redundant automatic
cover. **Reset design** resets the unsaved preferences and clears saved wording
from the draft; applying makes that reset durable.

**Hide this slide in the presentation** leaves the selected slide out of the deck
and video in any density. The narration still speaks its passage, so the shown
slide before it stays on screen (or, at the very start, the next shown slide opens
the deck). A section's features move to its shown slides, and its music
bed still plays. Hidden slides stay in the designer's list, struck through, and
still preview, so they can be shown again; AI never suggests wording for them. At
least one slide must stay shown. A hidden slide is remembered by a short key for
its exact passage, so editing that passage, or a density or layout change that
splits the section differently, shows it again.

**Customize slide wording (slides only)** overrides a section's opening headline
or highlights. With an AI model connected, **Suggest with AI** proposes headlines,
condensed points, and layouts one slide at a time. A deck of 3 to 16 slides to
suggest is first planned as a whole: one request chooses every slide's layout
together, so the deck varies by design (no layout on more than a third of the
slides), and each slide's request then uses its planned layout where the passage
can fill it. Each accepted suggestion appears in the
slide list and preview as soon as it arrives, marked **AI**; the footer shows which
slide is being suggested, and **Stop** keeps everything suggested so far. On a
slide that carries a feature, AI is asked for at most two short points. Only
accepted AI results are stored; failed suggestions get one repair attempt, then
retain the automatic version. AI never runs automatically while typing.

What the model is asked and how its reply is read are Squisq's (`presentationAuthor`
in `@bendyline/squisq/transform`), shared with every product that words a deck;
DocBlocks only makes the calls. A reply is held to its passage:

- A point in words the passage does not use, a number it does not state, or one
  end of a range shown as a key number refuses the suggestion. The repair request
  quotes the reason, and stops asking for a planned layout the passage could not
  fill.
- A layout that asserts a relationship the passage does not state is not refused.
  Its wording is kept and it is drawn as cards or a process: a cycle needs the
  passage to say it comes round again, a pyramid a hierarchy, a funnel stages that
  narrow, a Venn diagram something shared, a matrix its two axes.
- The reverse also holds. When the model plays safe with cards or a process and
  the section itself states a shape (a section called "The water cycle" that says
  the cycle repeats), the slide gets that drawing.
- What a small model gets nearly right is repaired: a key number written as a
  sentence has its figure moved to the front, dated points are led by their dates
  so they draw as a timeline, and a matrix whose points say where they stand
  ("low effort, high impact") gets its axes named and each point in its panel.
- A passage that addresses the model ("ignore all previous instructions") is not
  sent; its automatic slide stands.

`npm run eval:ai-presentations` runs this pipeline against a real model over
`packages/bench/fixtures/ai-presentations` and reports reply shape,
acceptance, whether passages with a shape were drawn with it, and faithfulness.
It needs an OpenAI-compatible endpoint (see the header of
`scripts/eval-ai-presentations.ts`).

Saved wording is tied to its exact source passage (the whole section for a manual
opening override). If “The sky is pink” changes to “The sky is blue,” the old AI or
customized wording stops applying and a fresh automatic summary is used. An
unrelated section edit can retain matching AI summaries. Changing density or the
supporting-slide design can change passage boundaries and therefore which AI
summaries still match. AI headlines may paraphrase and need editorial review.
Body points may condense the passage, but their numbers and most of their
distinctive words must come from it, and a point that restates the headline is
dropped; a suggestion whose every point does so is rejected. Models cannot
supply timing, source offsets, or invented image paths, and an image slide keeps
its picture.

Narration is a recording, so changing the spoken text still requires **Speech →
Generate narration…** again. Retaking the same text automatically re-resolves the
visual cues. Missing timing files, stale narration, and manually pinned slide
times are reported; MP4 export refuses an unsynchronized presentation. When pins
are the cause, the designer still previews the slides and offers **Remove pinned
times**. The Timeline offers no edge drags on a dynamic-slides document, and a
section's options there can only clear a pin. Without narration, the planner
uses estimated reading time.

**Export and share → Export video…** renders the dynamic slides with narration.
Keep the Markdown and its `<document>_files/` folder together; audio and adjacent
`<audio>.timing.json` sidecars live there. CLI video uses the same projection.

## Storage and shared implementation

Squisq owns the `dynamic-slides` transform style, `PresentationHints` schema,
`createPresentationPlan`, and `compilePresentationPlan`. The planner reuses
`transformNarratedSegment`, the deterministic extraction machinery used by
Qualla. DocBlocks owns the optional host AI calls and designer UI. The shared
editor exposes the designer beside Summarize in its preview toolbar.

The saved mode is `squisq-transform: dynamic-slides`. Version-1 JSON in
`squisq-presentation-hints` contains density, the supporting-slide preference,
and optional per-block preferences keyed by the parsed source block ID (a layout,
or `authored` to show the block itself). It
contains no automatic slide array, source offsets, or generated automatic prose.
Only explicit manual wording and actual accepted AI summaries carry source-text
snapshots. Renaming a heading can change its generated block ID; an unmatched
preference is ignored. Explicit source block IDs provide stable identity.

Existing version-1 `squisq-presentation` full plans remain readable. Applying the
designer replaces that legacy plan with dynamic preferences; choosing another
Summarize mode clears the legacy plan. These are undoable user actions.

Compilation derives seconds from the current narration bookmarks, including
edits and offsets. The timeline is locked against general slideshow pacing.
Without bookmarks, narration uses proportional estimates. Exact cue placement
does not establish acoustic word-boundary accuracy. Limits remain 40,000 script
characters, 80 slides, four points per slide, and 160,000 serialized hint
characters. This creates simple steps/comparison explainers and uses existing
images, videos, and diagrams; it does not generate images or record application
interactions.

## Verification

`packages/desktop/e2e/presentation.spec.ts` covers blank document → scripted AI
insert → narration → Slideshow → Summarize / Design… → supporting slides → AI summaries
and manual review → undo/redo → reopen from the Video toolbar → encoded MP4.
It checks that the document body remains byte-identical, hints persist without a
full saved plan, slide cues match the timing sidecar, and the MP4 has audio and
video with the expected duration. Only the native Save dialog is replaced with a
pre-authorized test destination; encoding and file saving are real.

The default run uses scripted speech. A production Kokoro run uses existing
local model and voice files:

```sh
DOCBLOCKS_E2E_KOKORO_MODEL=/absolute/path/model_quantized.onnx \
DOCBLOCKS_E2E_KOKORO_VOICE=/absolute/path/af_heart.bin \
npx playwright test --config=packages/desktop/e2e/playwright.config.ts \
  packages/desktop/e2e/presentation.spec.ts --reporter=line
```

AI remains scripted in this harness. Real-model editorial quality, acoustic word
boundaries, release packaging, and human approval of the launch film remain
separate qualifications. Local output under `reports/launch-presentation/` is
intentionally gitignored. Shipping requires publishing and pinning the changed
Squisq packages and shared Gezel frontend.

Verified locally on October 9, 2026 against linked Squisq:

- The complete desktop flow passed with both scripted speech and production
  Kokoro. The real run also passed a separate UI test for editing pink to blue
  and saving preferences with no generated prose.
- Four source sections produce five slides when supporting visuals are enabled.
  Their cues are 0, 12.375, 17, 22.2, and 36.75 seconds, over the unchanged
  47.875-second take. The added steps explainer starts at its word cue.
- Desktop output contains H.264 and AAC and lasts 48 seconds with encoder end
  padding. The independent CLI render lasts 47.933 seconds. Frames from the
  supporting steps diagram were inspected in both exports.
- The Squisq suite passed 7,176 tests (one skipped); its final compatibility
  adjustment passed the focused presentation suite. DocBlocks' full unit suite
  passed before the final incremental checks; the updated presentation/export/
  adaptive-style tests also passed. Both repositories passed types and lint,
  and changed-file formatting passed. This is not full release qualification.

The current real-audio project, screenshots, timeline, and desktop MP4 are under
`reports/launch-presentation/dynamic-real/`; `launch-cli.mp4` there is the separate
CLI render. The harness uses scripted AI that keeps each slide's own points, so
all five suggestions are accepted and cached; rejection of ungrounded and
headline-echoing suggestions is covered by `packages/react/test/presentation-ai.test.ts`.
