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

Choose a summary density, a preferred layout per section, and whether to add
supporting visual slides (on by default). A section can override the document-wide preference
with **Allow** or **Do not add**. Supporting slides explain ordered steps,
comparisons, or existing images when a passage has enough text. They share that
passage's narration interval; they do not add spoken filler or extend the take.
Layout preferences apply where the source has enough material for that layout.

**Use dynamic slides** saves the preferences and selects the Dynamic slides
summarization mode in one undoable edit. It also disables the redundant automatic
cover. **Reset design** resets the unsaved preferences and clears saved wording
from the draft; applying makes that reset durable.

**Customize slide wording (slides only)** overrides a section's opening headline
or highlights. With an AI model connected, **Suggest with AI** proposes headlines,
excerpts, and layouts one slide at a time. Only accepted AI results are stored;
failed suggestions get one repair attempt, then retain the automatic version.
Requests can be cancelled. AI never runs automatically while typing.

Saved wording is tied to its exact source passage (the whole section for a manual
opening override). If “The sky is pink” changes to “The sky is blue,” the old AI or
customized wording stops applying and a fresh automatic summary is used. An
unrelated section edit can retain matching AI summaries. Changing density or the
supporting-slide design can change passage boundaries and therefore which AI
summaries still match. AI headlines may paraphrase and need editorial review;
body points must be exact source excerpts. Models cannot supply timing, source
offsets, or invented image paths.

Narration is a recording, so changing the spoken text still requires **Speech →
Generate narration…** again. Retaking the same text automatically re-resolves the
visual cues. Missing timing files, stale narration, and manually pinned slide
times are reported; MP4 export refuses an unsynchronized presentation. Without
narration, the planner uses estimated reading time.

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
and optional per-block preferences keyed by the parsed source block ID. It
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
images; it does not generate images or record application interactions.

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
CLI render. The harness uses scripted AI: two deliberately ungrounded responses
are rejected, and only the three accepted AI summaries are cached.
