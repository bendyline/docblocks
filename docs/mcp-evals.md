# MCP content evaluation framework

This repository includes a local-only evaluation harness for measuring how well a
Codex agent uses the locally built DocBlocks MCP to author PowerPoint and Word
content. It is an experiment loop for MCP instructions, tools, CLI behavior,
Squisq authoring vocabulary, and prompts. It is not part of the published
`docblocks` command surface.

The harness uses Codex's non-interactive mode and injects the built `docblocks mcp`
process as a required local stdio server. Each generation runs in an isolated
read-only Codex sandbox; the MCP receives write authority only for that case's
report directory. Durable output still goes through `save_artifact`.

## What one run captures

For each canonical prompt, the harness:

1. builds and hosts the local CLI/MCP through `codex exec`;
2. asks the agent to author, validate, preview, convert, and save one editable
   Office artifact;
3. captures Codex JSONL events and the exact Markdown from the final
   `convert_document` call;
4. rejects a final-response Markdown copy that differs from the tool trace;
5. validates the OOXML ZIP package, required parts, native text, item counts, and
   density signals;
6. checks Markdown facts, structure, density, placeholders, and Squisq template
   intent deterministically;
7. optionally starts a fresh, tool-free Codex judge with a strict JSON schema;
8. writes a machine-readable result and a concise Markdown report.

Reports also aggregate generation latency, cached and uncached tokens, MCP call and
result sizes, and the text-versus-structured size of `get_authoring_context`. The LLM
judge records unsupported claims and missing requested elements as explicit arrays,
not only prose weaknesses.

Run artifacts are written below `reports/mcp-content-evals/`, which is gitignored.
Each case contains the prompts, output schemas, generation and judge traces,
stderr, authored Markdown, Office artifact, static judge results, and final score.
The run root contains `run.json` and `summary.md`.

## Commands

List the canonical cases:

```bash
npm run eval:mcp -- list
```

Run the quick suite. This builds core and the CLI before starting the harness:

```bash
npm run eval:mcp -- run --suite quick --label baseline
```

Run all canonical PowerPoint and Word cases with a pinned model:

```bash
npm run eval:mcp -- run --suite full --label candidate --model <model-id>
```

Run selected cases or use only deterministic judges:

```bash
npm run eval:mcp -- run --suite quarterly-product-review-pptx,build-vs-buy-decision-memo-docx --judge static --label focused
```

Use `--profile baseline` to measure MCP discoverability with only the execution
contract. Use `--profile content-first` to test explicit workflow coaching. The
profile, profile SHA-256, and judge-contract SHA-256 are recorded in provenance.
`--enforce` makes a run exit nonzero when any case fails required checks or the
score threshold.

To reuse an already built harness without rebuilding:

```bash
npm run eval:mcp:run -- run --suite quick --label rerun
```

## Scoring

The aggregate case score combines:

| Component                    | Weight with LLM judge | Purpose                                                          |
| ---------------------------- | --------------------: | ---------------------------------------------------------------- |
| Static Office artifact judge |                   35% | Package integrity, native parts/text, item counts, and density.  |
| Static Markdown judge        |                   25% | Brief facts, structure, density, placeholders, and template use. |
| Independent Codex judge      |                   40% | Content, narrative, format fitness, and Squisq quality.          |

When the LLM judge is disabled, deterministic weights are normalized to 100%.
Required static checks are hard gates regardless of the numeric score. A mismatch
between traced conversion Markdown and final-response Markdown is also a hard
failure. Within the LLM component, each material unsupported claim subtracts three
points and each missing requested element subtracts five points, capped at a
40-point grounding penalty. This prevents polish from masking unsupported content.

The LLM judge is a noisy measurement, not ground truth. Pin the model, keep the
suite and profile fixed, compare paired cases, and rerun material conclusions. The
judge receives authoritative deterministic word, section, density, and template
counts so arithmetic drift does not become qualitative feedback. Run provenance
includes a judge-contract SHA-256, and comparisons warn when that contract changes.
Static OOXML checks prove package and content properties; they do not substitute
for pixel-level review in PowerPoint or Word. The generation workflow's
`preview_document` call supplies an agent-visible Squisq render, while native-app
visual comparison remains future work.

## A/B workflow

1. Run a baseline before changing the MCP, CLI, or Squisq and retain its report
   directory.
2. Read `summary.md`, then inspect failing static checks, the exact `authored.md`,
   tool traces, and recurring LLM weaknesses. Form one falsifiable hypothesis.
3. Change the narrowest owning boundary. Authoring vocabulary belongs in Squisq;
   protocol policy and workflow guidance belong in DocBlocks MCP; host mechanics
   belong in this harness.
4. Run focused unit/MCP tests, rebuild, and rerun the same cases, profile, model,
   threshold, and judge mode under a candidate label.
5. Compare the paired runs:

```bash
npm run eval:mcp:run -- compare <baseline-run-directory> <candidate-run-directory>
```

Use `--enforce-no-regression` when the comparison is a CI gate. It fails when any
paired case regresses or changes from pass to fail, even if an aggregate gain masks
that regression. Comparison reports require the same case set and judge mode, warn
about model/profile/threshold/version drift, and show token, latency, and MCP-result
size deltas alongside quality. Review per-case deltas, not just the aggregate: a
change that helps decks but harms long-form documents usually needs a format-specific
instruction or capability.

For code-level A/B tests across separately built checkouts, pass `--cli-entry` to
the harness entry under test and keep the same Codex command/model. Do not make the
harness create branches or worktrees; repository state management remains with the
developer.

## Extending the framework

Canonical cases and prompt profiles live in
`packages/cli/src/eval/cases.ts`. Keep briefs factual, self-contained, and free of
external research so repeated runs measure authoring behavior rather than browsing.
Every case declares deterministic item, word, density, visual-template, and fact
expectations plus an LLM rubric.

The host and trace contract lives in `packages/cli/src/eval/codex-host.ts`.
Deterministic judges live in `artifact-judge.ts` and `markdown-judge.ts`. Scoring
and provenance live in `runner.ts`; paired reporting lives in `report.ts`.

Verify harness-only changes with:

```bash
npm run test:eval:mcp
npm run typecheck -w @bendyline/docblocks-cli
npm run build:cli
```

MCP or conversion changes still require the gates in [the MCP guide](mcp.md), up to
and including `npm run all` before release.
