# Dynamic slides and the Summarization designer

Open **View → Summaries** and choose **Custom** from the **Summary style** dropdown;
the designer appears below it. It is available in DocBlocksShell and the VS Code
editor.

Your document's prose, inline block tags, and narration stay unchanged; the design
is saved in the document beside them (see [Storage](#storage-and-shared-implementation)). Squisq
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

Choose a **Summary length**, a preferred layout per section, and whether to add
supporting visual slides (on by default). The dropdown lists the lengths from the
fewest slides to the most, each with the number of slides it makes of the current
document:

- **One slide per section** makes exactly one summary slide for each section,
  timed to that section's narration, however long the section is; it never adds
  supporting slides.
- **Key points** (the default) tells each section in one to three slides: one for
  a section of up to about 130 words, two up to about 330, three beyond that, and
  another for each further 220 words of a very long section. The narration tells
  the section; each slide shows what an audience should keep of its part.
- **Follow the text**, **Follow the text closely** and **Sentence by sentence**
  start a new slide every 64, 42 or 28 words and show the sentences each slide is
  made from. These were Detailed, Balanced and Concise; a 4,500-word post makes
  about 55, 85 and 108 slides with them, and about 23 as key points.

A key-points section is cut evenly at sentences, at a paragraph when one is near
the even cut, and never between a short list and the sentence that introduces it.
Each slide shows up to four points chosen from its passage: the items of a list
the author wrote (a numbered list draws as steps), otherwise the sentences that
carry the passage. Those are chosen for the words they share with the rest of the
section and its heading, for opening the passage or a paragraph, for saying they
are the point ("the lesson is…", "as a result…") and for stating a figure. A
sentence that only introduces a list, gives an example, or asks a question is left
to the narration, and two sentences that say the same thing are not both shown. A
point is the whole sentence when it fits in 140 characters, without the word that
joined it to the one before ("However, …"); a longer one loses its asides in
brackets, then is cut at a clause and marked with an ellipsis. One slide per
section chooses its points the same way. When the deck's opening passage is long,
the title slide shows as it begins, with its first sentence beneath it, and the
passage's points follow on a slide of their own.

**Slides for this section** sets how many slides tell the selected section, from 1
to 12, whatever the summary length; **Automatic** returns it to the document's
choice. The section is cut evenly and each of its slides shows its key points. A
section too short for the number asked makes as many as its text divides into, and
the designer says how many.

A section can override the document-wide supporting-slides preference
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

A block that draws a picture — a chart, a data table, a diagram, a drawing, a
layout, a map, a tree or a timeline — can instead be shown **On the last slide of**
the section before it, labeled with that section and the block type, such as
**On the last slide of “Results” (Bar Chart)**. The block makes no slide of its own:
it is drawn, as its real chart or diagram, beneath the headline and up to two short
points of that section's last slide, while its own text is still narrated with that
slide on screen. "The section before it" is the nearest section before it in the
document that makes slides, so a `##` chart after a `##` section of prose joins
that section. Several in a row join the same slide, up to four things on one
slide; if that slide was a full-screen picture, it becomes a text slide with the
picture beside the block. The block is drawn still, without its entrance or its own
builds. In the slide list it stays as an entry without a number, tagged with its
type and the slide carrying it; selecting it previews that slide, and the carrying
slide is tagged **+ Bar Chart**. The status line counts it apart
(_4 slides · 1 on another slide_). When nothing can carry it — nothing comes before
it, the section before it is shown as authored or has every slide hidden, or that
slide already carries four things — it gets a slide of its own as if shown as
authored, and the designer says why beside the layout choice. Nothing narrated
changes, so recorded narration still fits and switching back restores the deck.

Automatic slides are titled with their section heading and show the section's
own sentences beneath it, so a slide never repeats its title as its body. Each
document image appears once, on a slide from the section that contains it. In a
key-points deck a picture keeps the section's points: it takes a supporting slide
of its own when the passage is long enough to share and supporting slides are on,
and otherwise sits beside the words of the section's last slide.

A section's features (its tables, its pictures, and its embedded videos and
diagrams: a `<video>`, a hosted video, a Mermaid or SVG fence, or a `diagram` /
`tree` / `timeline` fence) appear on its slides in every layout and at every
summary length rather than being dropped. The section's slides are shared out among them in
source order, so every one is shown. A table, picture, diagram or HTML video stays
on screen across consecutive slides, and the video plays on from where the
previous slide left it instead of restarting. A key-points section, or one with its
own slide count, shows a table once instead, on the slide whose passage speaks of
it, so its other slides keep the room for their points. A picture normally gets its own
image slide; when no slide shows it that way (a layout preference other than
Image, or more pictures than slides) it appears beside the slide text instead. A
slide that carries one prefers a list over a steps diagram, unless the section's
layout preference says steps. Timed clips attached to a section, such as a
`{[audio …]}` music bed, start on its first slide and stop where the section ends.

A slide that carries a feature keeps its words short so the feature has the room:
at most two points, each cut at a clause near 100 characters (points typed in
**Customize slide wording** stand as written). The words summarize the section's
prose: a table's cells and a diagram's source never become a slide's points, and
never start a slide of their own at any summary length. A table is drawn whole beneath
the headline and points at the slide's full width, its cells wrapping and keeping
their own line breaks, with the type set as large as every row allows. A chart
section summarized this way shows its data as a table; show it **As authored** to
draw the chart on its own slide, or **On the last slide of** the section before it
to draw it there.

Each change is saved as it is made, as one step Ctrl+Z in Write undoes. **Reset
design** returns every slide to its automatic summary: it removes the section
settings, the summary keys, and every `{[summary]}` block, including ones not in use.

**Hide this slide in the presentation** leaves the selected slide out of the deck
and video at any summary length. The narration still speaks its passage, so the shown
slide before it stays on screen (or, at the very start, the next shown slide opens
the deck). A section's features move to its shown slides, and its music
bed still plays. Hidden slides stay in the designer's list, struck through, and
still preview, so they can be shown again; AI never suggests wording for them. At
least one slide must stay shown. A hidden slide is remembered by a short key for
its exact passage, so editing that passage, or a change of summary length, slide
count or layout that splits the section differently, shows it again — the summary that hid it is listed
as **not in use**, and hides the slide again if the passage returns.

**Customize slide wording (slides only)** overrides a section's opening headline
or highlights. Your wording stays when you edit the section's text; **Use automatic
wording** removes it. With an AI model connected, **Suggest with AI** proposes headlines,
condensed points, and layouts one slide at a time. A deck of 3 to 16 slides to
suggest is first planned as a whole: one request chooses every slide's layout
together, so the deck varies by design (no layout on more than a third of the
slides), and each slide's request then uses its planned layout where the passage
can fill it. Each accepted suggestion appears in the
slide list and preview as soon as it arrives, marked **AI**; the footer shows which
slide is being suggested, and **Stop** keeps everything suggested so far. On a
slide that carries a feature, AI is asked for at most two short points. A slide
whose passage is long (450 characters or more, as a key-points slide of a long
section is) is asked about differently: the request says to summarize, the model
is asked for the two to four ideas worth remembering from the whole passage as
phrases of at most twelve words, and it is not shown the automatic slide's points,
which are sentences of the passage a small model tends to hand back. A point
longer than 140 characters on such a slide is refused and asked for again as a
short phrase. A key-points deck also asks far fewer questions: about 23 requests
for the 4,500-word post above, where Sentence by sentence made 108. Only
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
`scripts/eval-ai-presentations.ts`). It plans decks at the designer's default
length; `-- --density balanced` plans them as runs before key points did. The
docbench presentation task (`packages/bench/src/tasks/presentation.ts`) stays on
`balanced`, so its scores remain comparable with recorded rounds.

Saved wording is tied to its exact source passage (the whole section for a manual
opening override). If “The sky is pink” changes to “The sky is blue,” the old AI or
customized wording stops applying and a fresh automatic summary is used. An
unrelated section edit can retain matching AI summaries. Changing the summary
length, a section's slide count or the supporting-slide design can change passage
boundaries and therefore which AI summaries still match. AI headlines may paraphrase and need editorial review.
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

The saved mode is `squisq-transform: dynamic-slides`. The design lives in the
document, where it can be read and edited by hand (Squisq's `readPresentationHints`
and `writePresentationHints`):

- **Document settings** are frontmatter keys: `squisq-summary-density` (`section`,
  `keypoints`, `detailed`, `balanced` or `concise`) and
  `squisq-summary-supporting-slides: false`. The density is left out at
  `keypoints` unless the document holds summaries keyed to a passage, which are
  always written with it. A document with such summaries and no density was
  designed when `balanced` was the default, and is read as `balanced`, so its
  hidden slides and AI wording still apply; the designer writes the key the first
  time its design changes. Any other document without the key is summarized as key
  points.
- **Section settings** are on the section's heading tag: `slideLayout=` (a layout,
  `authored` to show the block itself, or `feature` to draw a picture block on the
  last slide of the section before it), `supportingSlides=` and `slideCount=` (1 to
  12).
- **Slide designs** are `{[summary]}` accessory blocks under the section. The
  heading is the slide's headline and the first list its points. A summary
  without `passage=` words the section's opening slide; `passage=<key>` names one
  slide by a short key of its exact passage; `origin=ai` marks an AI suggestion;
  `hidden=true` hides the slide; `points=none` shows no points.

Accessory blocks are never slides, narration, captions, or exported content. Write
folds a section's summaries into one **Slide summaries** row; Source folds each.
Nothing automatic is saved: no slide array, source offsets, or generated prose.

Designs saved by earlier versions as version-1 JSON in `squisq-presentation-hints`
remain readable and play as before; the designer replaces the key with summary
blocks on the first change, keeping what still applies. Version-1
`squisq-presentation` full plans remain readable too; choosing another summary
style clears that legacy plan. Apps released before summary blocks show them as
ordinary sub-sections.

Compilation derives seconds from the current narration bookmarks, including
edits and offsets. The timeline is locked against general slideshow pacing.
Without bookmarks, narration uses proportional estimates. Exact cue placement
does not establish acoustic word-boundary accuracy. Limits are 40,000 script
characters, 300 slides, four points per slide, a headline of 110 characters, and
points of 180. This creates simple steps/comparison explainers and uses existing
images, videos, and diagrams; it does not generate images or record application
interactions.

## Verification

`packages/desktop/e2e/presentation.spec.ts` covers blank document → scripted AI
insert → narration → Summaries (Custom) → supporting slides → AI summaries
and manual review → undo/redo → reopen from the Video toolbar → encoded MP4.
It checks that what is narrated stays identical, the design persists as summary
blocks without a full saved plan, slide cues match the timing sidecar, and the MP4 has audio and
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
