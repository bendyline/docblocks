# docbench

docbench scores a language model on the AI work DocBlocks does: reviewing a
resume, drawing an SVG illustration, wording slides, and (as the task matrix
fills in) writing, diagrams, study aids and narration. It produces one number
per model, 0–100, with family sub-scores and 95% intervals, so DocBlocks and
Gezel can recommend the best model a person's hardware can run.

Two repositories share the work:

| Repository                                    | Owns                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DocBlocks (`packages/bench`)                  | **What is tested**: fixtures, task adapters that run the product's real AI pipelines, deterministic checks, judge rubrics, family weights.                               |
| Gezel (`evals/src/docbench`, `eval:docbench`) | **How**: models and engines (a trial `gezeld` with catalog tuning), judging with a pinned Claude judge, statistics, the report, and later publishing and recommendation. |

They meet through a JSON contract over a process boundary, never an import:
`docbench-pack describe` prints the pack manifest, and `docbench-pack run`
writes one outcome per case. The TypeScript side is
[`packages/bench/src/contract.ts`](../packages/bench/src/contract.ts); Gezel
validates every document with its Zod copy in
`@bendyline/gezel/eval` (`packages/core/src/eval/bench-pack.ts`). Change both
together.

## Why the pack runs product code

A benchmark that restates a prompt measures the restatement. Every task
adapter calls the functions the editor calls:

- requests are built by the same builders, and sent with the same body the
  desktop sends (`buildChatCompletionBody` in `@bendyline/docblocks/host`):
  reasoning off except for writing, structured output only when a schema is
  given, a local draft's cap at the context window;
- replies are read by the same readers, with the same repairs and retries;
- the review loop is the panel's own (`reviewDocument` and
  `readReviewReply` in `packages/react/src/Ai/review-run.ts`, which the
  Review panel also uses);
- budgets follow the context window the endpoint reports, as the desktop's do.

The pipelines are exported without UI from `@bendyline/docblocks-react/ai`.
Some reach Squisq's editor package, which expects a DOM, so the pack
registers happy-dom before loading them (`packages/bench/src/dom.ts`).

## The task matrix

| Family (weight)                  | Tasks in 0.2                                                                                                                                                                                                                               | Judge                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Review and feedback (25%)        | `review-general` (weight 3): moderate-quality documents seeded at three depths. `review-resume`, `-facts`, `-concise`, `-plain`, `-strunk`, `-un`: each style's own seeded documents, with decoys for facts and concise. `review-creative` | Matcher with complexity levels; the creative style by rubric                              |
| Writing new content (25%)        | `write-compose` (from scratch), `write-append`, `write-insert` (a named place mid-document), `write-rewrite` (six kinds of selection rewrite)                                                                                              | Rubric: instructions, faithfulness, fit, quality; the desktop's own fact check as a check |
| Diagrams and illustrations (20%) | `diagram-plan` (rules only), `diagram-draw`, `illustration-svg`, `design-brief`                                                                                                                                                            | Rubrics; vision on the rendered SVG                                                       |
| Presentations (10%)              | `presentation-slides`                                                                                                                                                                                                                      | Rubric on the worded slides beside their passages                                         |
| Study aids (15%)                 | `study-summary`, `study-quiz`, `study-flashcards`                                                                                                                                                                                          | Rubric with the facts a good aid covers                                                   |
| Narration cleanup (5%)           | `narration-cleanup`, including a transcript that quotes an instruction                                                                                                                                                                     | Rubric with a reference edit                                                              |

**Review depth.** Seeded problems carry a `level`: _low_ is mechanical (a
typo, punctuation, a number's format), _medium_ is a sentence (wordiness,
passive voice, an inconsistent term), _high_ is the paragraph or document (a
buried request, a contradiction between sections, a missing prerequisite).
The judge labels every finding the same way, so a report counts how many
valid low, medium and high suggestions a document got, and recall weights a
high issue three times a low one: a review that only fixes typos scores
little.

**Content generation.** Compose drafts "Markdown to insert at the current
cursor", but the product never shows the model where the cursor is, so the
append and insert cases name the place in their instructions as a person
would, and the judge reads the result spliced in where it would go. That gap
is the product's, and docbench measures the product as it is.

A family is the weighted mean of its tasks (weight 1 unless the pack says
otherwise); docbench is the weighted mean of the families present.

A case scores 0 when DocBlocks would have shown the person nothing from the
model. Otherwise it blends the task's deterministic checks with the judge, by
the task's `scoring` weights. Review findings are matched against seeded
defects with F1, so a review of "This is a correct sentence" earns nothing
however well-formed it is. Endpoint failures (a refused connection, an HTTP
error, a timeout) are classified as infrastructure, retried, and never scored.

## Running it

### The DocBlocks dev loop: checks only

Against any OpenAI-compatible endpoint, such as a standalone
`gezel-llama-server` on a GGUF file:

```bash
npm run build:core && npm run build:react
npm run docbench -- local --endpoint http://127.0.0.1:18461/v1 --models lfm3-1.7b-q4 --label my-change
```

It runs every trial each task asks for and writes outcomes and a summary to
`reports/docbench/<label>/`. There is no judge, so the summary is the
deterministic checks alone: use it to see whether a prompt or parser change
broke something, not to rank models. A bearer token, when the endpoint needs
one, goes in `DOCBENCH_ENDPOINT_TOKEN`. The context window comes from the
endpoint's `/v1/models` unless `--context` overrides it.

### The docbench score: Gezel

From a Gezel checkout beside this one, with the pack built
(`npm run build:bench`):

```bash
pnpm eval:docbench --models qwen3.5-2b-q4,gemma4-12b-q4 --run-id my-round --allow-download
```

See Gezel's `evals/README.md` for the flags. The run writes
`evals/runs/docbench-<run-id>/` with every case, every verdict, the rendered
pictures, `summary.json` and `report.md`.

### Fixture sets and the holdout

`docbench-pack describe` reports which fixtures it read and a hash of their
content; Gezel records it with every round and refuses to resume a round on
different fixtures. `DOCBENCH_FIXTURES_DIR` (Gezel: `--fixtures <dir>`) swaps
in another set laid out like `packages/bench/fixtures/`. Keep a holdout set
that way, outside this public repository: a gap between a model's public and
holdout scores means prompts or fixtures have been tuned to each other.

### Judge validity

Before a round's scores are published, and whenever the judge or its prompts
change, Gezel's `eval:docbench-validity` re-judges a sample (the score must
not wander), has a second judge score it (the two must agree), and judges
deliberately damaged copies of good outputs (they must score lower). A round
is publishable only when its judge passed.

### Where a published score goes

Gezel's `eval:docbench-publish` turns a publishable round into a scorecard
shard (the handboek's docbench table and model pages) and a
`benchmarks.docbench.<engine>` entry in each model's Gilde manifest. Once that
Gilde release ships, Gezel's `/v1/models` carries a `docbench` block on every
measured model, installed or downloadable. For downloadable models it also
sends `docbench_recommendation`, a second ranking by measured quality among
the models that fit this device. DocBlocks reads both through
[ai-models.ts](../packages/desktop/main/ai/ai-models.ts). It prefers the
docbench ranking over Gezel's general one, which weighs agent work DocBlocks
never does. The `docbench` result then crosses the host boundary as
`AiModelDocbench` (validated in `parseAiModelDocbench`), and Settings → AI
shows it in the model picker and the Add-model list, with the family
breakdown under the selected download. A score is served only while the
catalog still ships the build that was measured, so a re-quantized model
shows no score until it is measured again.

## Adding a task

1. Add fixtures under `packages/bench/fixtures/<family>/`. Seeded defects must
   be obvious: the difficulty is finding them all without flagging sound
   text, not spotting subtle ones.
2. Add an adapter in `packages/bench/src/tasks/` that calls the product
   pipeline, reports `usable` as "the product would show the person
   something", and returns checks, the artifact and the judge input.
3. Register it in `packages/bench/src/pack.ts`, give its rubric a versioned
   `rubricId`, and bump `DOCBENCH_VERSION`: scores are compared only within
   one version.
4. Test it against a scripted endpoint in `packages/bench/test/`: a good
   reply passes, a useless one parses but leaves the judge nothing to credit,
   a garbled one is not usable.

If a pipeline's logic lives in a component, move it into a headless function
first, as the review loop was, so the panel and the pack share it.
