# DocBlocks launch video plan

The implementation is available in the linked DocBlocks and Squisq checkouts.
**Dynamic slides** is an advanced Summarize mode. The **Summarization designer**
opens from **Design…** beside **Summarize** in Slideshow/Video and saves preferences plus optional
source-bound AI/manual wording, without saving deterministic generated prose.
Slides regenerate from current text at preview and export time. Squisq owns the
planner, schema, compiler, and word-cue timing; DocBlocks owns the host AI calls
and designer UI. See [Dynamic slides](presentations.md) for the workflow.

Qualla already delegates deterministic segment generation to Squisq's
`transformNarratedSegment`. The new planner reuses that extraction machinery,
then compiles a constrained set of source-anchored layouts against narration
bookmarks. It does not copy Qualla's application code or its low-level AI slide
JSON generator. Dynamic slides is its own transform style and locks the compiled narration
timeline against generic slideshow pacing.

The desktop harness now passes blank-document AI insertion, narration,
automatic layout, AI refinement, manual editing, one-step undo/redo,
save/reopen, and actual MP4 export. AI is scripted in this harness; a separate
mode runs production Kokoro inference with cached model and voice files.
The initial target remains desktop. Automatic planning is also wired into the
VS Code editor, while AI and speech depend on each host's capabilities.

| Requested step           | Implementation now                                                                                                           | Remaining qualification                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Draft from bullet points | Existing AI compose inserts Markdown into a blank document.                                                                  | Better presentation-oriented compose guidance and real-model editorial evaluation.                              |
| Divide into blocks       | Heading structure feeds the canonical narration script, retaining parent prose.                                              | Evaluate sparse, long, and complex briefs.                                                                      |
| Attach narration         | Kokoro audio and v3 word-cue sidecar are saved beside the document.                                                          | Acoustic boundary calibration, other voices, persisted timing provenance, and broader failure/retake scenarios. |
| Improve presentation     | Automatic source-anchored plan, six layouts, steps diagrams, existing images, optional bounded AI refinement, and review UI. | Real-model quality comparisons and a polished launch brief with product imagery.                                |
| Export narrated MP4      | Current text and preferences compile through shared Squisq logic for desktop and CLI.                                        | Release/package qualification and final human review of the launch video.                                       |

Implementation also fixed problems exposed by the full workflow: sidecars saved
under a duplicated media directory, frontmatter changes bypassing rich-text undo,
unresolved workspace audio URLs briefly reaching the app origin, repeated AAC
encoder flushes overlapping timestamps, and transparent diagram slides exporting
against a black background. The presentation supplies its opening, so applying it
disables the extra automatic cover slide.

**Initial audit and design rationale — retained below for context**

The findings below preceded the implementation. In particular, the historical
generic-transform measurements do not describe the new saved-plan path. The
original sidecar proposal was replaced with bounded JSON in frontmatter, making
plan application, undo, and save atomic without another asset-reference protocol.

Key implementation evidence:

- [AI writing prompts](../packages/react/src/Ai/ai-assistant.ts) ask compose for ordinary Markdown. Only rewrite explicitly describes preserving Squisq annotations.
- [Narration generation](../packages/react/src/Speech/useGenerateNarration.ts) already calls Squisq's `buildNarrationSavePlan` and `executeNarrationSave`. It saves `<audio>.timing.json`; a new root `timing.json` format is unnecessary. MP3 is not required for the narrated MP4 workflow.
- [TTS alignment](../packages/react/src/Speech/tts-narration.ts) now prefers model-derived word allocations, retaining original script offsets through spoken expansions and chunk splits. Engines without valid duration metadata fall back to syllable estimates.
- [Video projection](../packages/react/src/Export/video-export-doc.ts) resolves narration before transforms and suppresses preview image fillers when narration owns the timeline.
- [CLI video](../packages/cli/src/commands/video.ts) passes `readInput().doc` directly to `renderDocToMp4`; it does not perform the GUI's saved-transform and `buildPreviewDoc` steps.
- [AI diagrams](../packages/react/src/Ai/illustrate-prompts.ts) already demonstrate the desired bounded planning pattern: small JSON proposals, grounded source passages, deterministic compilation, and validation.

Qualla's current [segment generator](../../qualla-internal/shared/story/generation/SegmentSlideshowGenerator.ts) delegates to [Squisq's `transformNarratedSegment`](../../squisq/packages/core/src/transform/narratedSegment.ts). Content analysis, template selection, media interleaving, and duration allocation have already moved upstream. Its input includes segment text and audio duration, but no word bookmarks. Reuse and extend that machinery. Qualla's separate `GenerateStoryCommand` asks a model for low-level slide JSON; it is less suitable than the existing validated diagram pattern for the new DocBlocks feature.

**Validation findings that change the order of work**

Seventeen focused DocBlocks tests passed across speech planning, generated alignment, video projection, and export media resolution. The existing [desktop speech E2E](../packages/desktop/e2e/speech.spec.ts) covers generated narration, saved audio, v3 sidecar, and audio export; that test was inspected, not executed during this audit. These checks do not establish that the complete launch workflow produces a synchronized MP4.

A synthetic composition probe uses one H1 with body prose and two H2 sections, with a 60-second narration sidecar allocating 20 seconds to each section. All styles receive the same source and timing data:

| Transform   | Projected duration | Opening section preserved |
| ----------- | -----------------: | ------------------------- |
| None        |         60 seconds | Yes                       |
| Minimal     |         60 seconds | Yes                       |
| Documentary |         40 seconds | No                        |
| Narrative   |      67.76 seconds | No                        |
| Magazine    |      64.76 seconds | No                        |

These are projection results, not measurements of an encoded MP4. They nevertheless demonstrate that the current composition is not a reliable timing contract. The local reproduction is [probe.mjs](../reports/launch-video-audit/probe.mjs), with [results](../reports/launch-video-audit/projection-results.json); `reports/` is intentionally gitignored. Promote its fixture into regression tests during implementation.

Linked-package provenance checks passed against clean Squisq commit `c21c23587395c118c685cdbb30400fe6b840445b`, including source/build freshness and registry parity. This describes the local linked checkout, not every published package combination.

The pinned Kokoro model can supply synthesis durations. The exact `onnx/model_quantized.onnx` at revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` exports only `waveform`, but retains the per-input-token duration tensor used by its alignment expansion. A temporary research copy exposes `/encoder/Gather_output_0` as an additional output without changing any graph node or weight. The original file's SHA-256 matched the [DocBlocks pin](../packages/desktop/main/speech/speech-models.ts): `fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478`.

Nine real inference cases passed using the current DocBlocks phoneme frontend, the pinned `af_heart` voice, and speeds 0.75, 1, and 1.25. Each input token received an integer duration; their sum multiplied by 600 equaled the waveform sample count exactly. At 24 kHz, each duration unit is 25 ms. Audio from the exposed graph was sample-for-sample identical to the original in all nine cases. Normalized word-to-token mapping also matched the whole-utterance frontend output, including `42%` becoming “forty two percent” and `$3.50` becoming “three dollars fifty cents.” Local reproduction: [graph probe](../reports/launch-video-audit/expose-kokoro-durations.py), [inference probe](../reports/launch-video-audit/kokoro-duration-probe.mjs), and [results](../reports/launch-video-audit/kokoro-duration-results.json). These research files are gitignored; no application runtime or installed model was modified.

These are exact synthesis frame allocations, not yet calibrated acoustic word boundaries. Kokoro's [model implementation](https://github.com/hexgrad/kokoro/blob/main/kokoro/model.py) returns duration predictions, and its [Python pipeline](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py) derives word timestamps with padding and pause adjustments. Qualify those adjustments against audible speech before claiming precise word onsets. The probe establishes feasibility for one English voice and three short sentences, not all voices or long-form chunking.

Implemented after this audit: DocBlocks now pins the existing published timestamped q8 export at revision `dd4401a9add81ac692d20e240d22ec9dda82cc29`, SHA-256 `c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c`. It contains identical weights; the same nine inference comparisons produced identical audio. Its float32 `durations` output precedes ONNX Round (ties to even) and Clip(min=1), so timing consumers must apply those operations to recover the integer frame allocations. The original voice pins remain unchanged. An explicit Settings update path recognizes changed model pins, reuses verified files, and supports failure/cancellation retry. See [speech model updates](speech.md#kokoro-export-and-model-updates). The shared Gezel frontend now preserves word/source mappings; DocBlocks consumes the duration output, validates optional chunk word timings across IPC, and saves their starts in v3 sidecars. The Gezel frontend changes must be published and pinned before shipping. Acoustic calibration and persisted per-word quality provenance remain outstanding.

**Design decision: narration and visual wording have different jobs**

Keep the approved narration script and its audio take stable while improving the visuals. A spoken paragraph may produce a short headline, a comparison, a diagram, and a closing line. Those visuals must reference spans of the original script even when their displayed wording differs.

For example, the narration “Start with a few bullet points and build your document” might display “Start with an idea” and a simple bullet-points-to-document diagram. Shortening that headline must not change the script, regenerate the voice, or cause fuzzy matching to bind it to a different passage.

The default action should be **Prepare for slides**, which keeps narration unchanged. A separate **Rewrite narration** action can change the script and explicitly regenerate affected audio/timing. This preserves the requested order of draft → narrate → improve visuals → export. Reordering the spoken argument belongs before narration or requires a new take.

**1. Establish one narration-preserving projection in Squisq**

Start in `transform/blockAnalyzer.ts`, `transform/templateSelector.ts`, `transform/timingAllocator.ts`, `transform/narratedSegment.ts`, and `doc/buildPreviewDoc.ts`. Preserve the body of parent headings as well as their descendants. Carry source anchors even when a transform finds no highlight to promote. Fit added visuals inside the existing narration interval; extra headers, images, and closing slides must not push later narration anchors or silently extend the presentation.

Make incompatible pacing constraints explicit. If too many slides fit poorly into a short passage, merge or omit optional beats and return a diagnostic. Do not satisfy a minimum slide duration by moving a later spoken cue. Respect author timing pins, but surface conflicts with narration instead of promising synchronization.

Extract a shared Squisq projection function for audio resolution, data resolution, persisted presentation choice, and final player blocks. Wire the editor preview, Timeline monitor, DocBlocks GUI export, and CLI video through it. Check HTML playback and MCP preview against the same contract; keep their existing authority and artifact boundaries.

Acceptance: the fixture above preserves coverage of all source sections and the 60-second narration interval for every supported style. Nested headings, images, existing explicit templates, intro/outro beats, and author timing pins receive regression coverage. Preview and export consume equivalent projected timelines.

**2. Strengthen the narration take and timing contract**

Retain the existing v3 sidecar and document audio annotation. Add a versioned extension only for information that cannot currently round-trip: stable take identity, a hash of canonical spoken text, voice/model/speed provenance, and timing quality per span or word. The in-memory `interpolated` flag is currently omitted when alignment becomes sidecar bookmarks.

Expose a canonical script-span-to-time resolver in Squisq. It must use the same text normalization and offset coordinate system as narration, including headings, punctuation, lists, numbers, and omitted code. The current transform's `sourceCharOffset` refers to analyzed block text, while the sidecar offsets refer to the whole spoken script; these are not interchangeable.

Prefer Kokoro's native duration output for generated narration. The reviewed timestamped export is now pinned as described above; consume its `durations` output and apply the model's rounding/clamping rules. Do not patch installed models at runtime. Keep estimated timing as an explicit fallback for hosts that do not provide word timings. Forced alignment remains an option for imported or recorded audio, or if measured boundary accuracy warrants it; generated narration should not require a second speech model by default.

Implemented in the sibling Gezel checkout: source ranges survive normalization, spoken expansions, phonemes, dropped unsupported symbols, and actual emitted token indexes. `planKokoroSpeech` carries them through model-sized chunks, including overlong words. One source span can own several spoken words, such as `42%`; padding and spaces contribute to the audio timeline without becoming words. Publish and pin that shared API before release.

Implemented in DocBlocks: the utility converts model allocations to word intervals; `SpeechAudioChunk` carries optional bounded `wordTimings`; the parser, IPC forwarding, and narration alignment preserve offsets into the assembled take. The v3 sidecar stores the word starts. Focused tests cover source ranges, rounding/clipping, duration accounting, currency, Unicode, repeated words, long splits, malformed metadata, and estimated fallback. Real inference tests cover `af_heart` at three speeds. Remaining qualification includes other voices, acoustic boundary error, and persistent timing quality/provenance.

Harden generation in `useGenerateNarration`: capture document generation and script identity, bound total work, drain encoder appends with backpressure, cancel before every commit stage, reuse save progress on retry, and clean up operation-owned orphaned assets. The underlying Squisq saver already exposes progress/cleanup primitives. Stage assets before attaching their reference, and report durable success only after the DocumentSession commit is acknowledged. Concurrent source edits must produce a stale-take state or safe regeneration, never silently attach obsolete narration as current.

Acceptance: save, close, reopen, rename/move, retake, cancel, save failure/retry, and DBK export/import preserve correct audio/timing references. A changed script is detected even if headings retain the same IDs. Cosmetic visual changes do not invalidate the voice.

**3. Add an AI presentation plan and deterministic compiler**

Squisq should own a proposed `PresentationPlan` schema, exact parser, validation, and compiler. DocBlocks should own the AI request orchestration and review UI through `host.ai`. Keep generic rendering and timing independent of an AI provider.

Each visual beat should contain a stable ID, source block and canonical script span, editorial purpose, concise display content, a registered template choice, and optional diagram specification or existing asset reference. The plan records the source/take identity and version. The compiler derives times from narration bookmarks; the model does not invent second values or pixel geometry. Use existing `sourceBlockId`, `sourceCharOffset`, `sourceStartTime`, and `sourceDuration` concepts where compatible, rather than creating a parallel timeline system.

Generate a small outline first, then realize one section at a time in source order. Reuse the AI diagram pipeline's conservative context budgeting, serial calls, cancellation, exact JSON validation, grounding checks, and bounded repair attempts. Keep unsupported facts, invented statistics, and unavailable asset paths out of the compiled plan. A failed suggestion should leave the prior presentation usable.

Begin with a constrained template set suited to a product launch: title, concise content/list, fact card, comparison/two-column, quote only where supported, diagram, and closing call to action. Reuse available screenshots or images; the first milestone does not need an image-generation or stock-search dependency. Apply text-density, duration, repeated-template, clipping, and source-coverage checks before offering a preview.

Persist accepted plans as versioned sidecars beside the document media, referenced through a Squisq-owned Markdown/frontmatter contract. Preserve the source prose as the narration script. Applying a new immutable plan reference is one undoable source edit through the editor and DocumentSession. Editing a visual beat produces another plan revision; undo restores the prior reference. Teach asset collection, rename/move, DBK bundling, CLI, and playback to carry the plan. An accepted plan replaces the generic transform for that projection, so it cannot be transformed twice.

Acceptance: the same validated plan compiles deterministically after reopening; every visual has a valid source association; all narration intervals retain visual coverage; display edits do not alter spoken text; stale plans require regeneration or explicit review. Malformed model output cannot corrupt the document.

**4. Make the complete flow understandable in the editor**

Add a presentation-oriented compose option with a short Squisq guide derived from the actual template registry: one meaningful heading per major point, concise sections, correct annotation placement, and no unsupported syntax. Keep ordinary drafting lightweight. Test the returned Markdown by parsing and round-tripping it, including insertion into a blank document.

Add **Prepare for slides…** to the AI menu, with audience, purpose, and optional target length before narration. With narration already present, show its actual duration and preserve it. Offer editable beat cards with their source excerpt, displayed text, template, and timed preview. Include a deterministic automatic-layout option when AI is unavailable.

Connect the existing Speech → Generate narration action with presentation preview and Export video. Show progress for planning, narration, saving, and rendering; retain cancellation and retry behavior. Update `docs/speech.md`, which currently describes read aloud but omits the generated-narration workflow. Wire editor-area features into VS Code explicitly if that surface is included; desktop remains the first full creation path.

**5. Prove the flow with DocBlocks creating its launch video**

Use a fixed, approved brief containing only verified product claims: writing from a few points, structured Markdown, diagrams, local narration, and reusable presentation/video output. Target a 60–90 second story with roughly 8–12 visual beats, adjusted to the voice and content. Include actual DocBlocks screenshots when helpful and an approved closing action. Do not make automatic UI recording part of this first milestone.

Build three complementary checks:

1. Deterministic integration coverage: fixed AI responses and synthetic speech through blank document → insertion → narration → plan → save/reopen → MP4. Verify timestamps, stale-result rejection, one-step undo, cancellation, missing assets, timing pins, and save failure. Extend the existing desktop speech fixture so it exports video as well as audio.
2. Real speech and encoding: use the actual selected local voice on a short fixture, then the whole launch script. Inspect MP4 audio/video streams, duration, non-silence, first/last frames, and frames around each cue. Compare player and exported frames at the same times. As initial acceptance targets, bound end-of-video drift to 100 ms and measured cue error to 250 ms at the 95th percentile; distinguish compiler-to-bookmark accuracy from bookmark-to-audible-word accuracy. Revise these thresholds only with measured perceptual evidence.
3. Presentation quality: compare plain slides, deterministic Squisq transforms, and AI plans using the identical narration take. Judge factual fidelity, story progression, visual relevance, readability, pacing, and useful variety. Include sparse briefs, long prose, nested headings, repeated phrases, lists, numbers/acronyms, and diagram-heavy content. Exercise a small local model with a 4K context as well as a stronger configured model. Record generation time, failures, repair attempts, and user edits needed.

The release demonstration must start in the desktop UI and finish with an MP4 that has been watched and heard in full. Keep the Markdown, narration audio, timing sidecar, presentation plan, screenshots, and output video together so another person can reproduce it. Automated tones can prove plumbing but cannot establish natural voice quality or word synchronization.

**Implementation status and remaining release gate**

The timestamped Kokoro pin, shared frontend source mapping, narration sidecar
path, constrained presentation compiler, AI refinement, review UI, and desktop
end-to-end harness are implemented locally. Shared tests cover parent prose,
source coverage, exact bookmark placement, retakes, stale plans, missing timings,
invalid model output, cancellation, and preservation of narration across undo.
The current saved-plan path bypasses the older style transforms; this work does
not claim to repair every legacy transform mode.

Before shipping, publish the changed Squisq packages and Gezel frontend API,
pin those releases in DocBlocks, and repeat qualification against the published
artifacts. Real-model editorial quality, acoustic word-onset measurements,
other voices, a polished launch story, and packaged/surface visual release gates
remain separate work. The full DocBlocks `npm run all` gate encountered existing
generated-notice drift from linked dependencies; unrelated notices were left
unchanged and the later relevant unit, type, lint, and formatting checks were run
separately. Current verification details belong in [Dynamic slides](presentations.md).
