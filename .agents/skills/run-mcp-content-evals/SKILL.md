---
name: run-mcp-content-evals
description: Run, interpret, and compare the repository-local DocBlocks MCP content evaluation harness for PowerPoint and Word authoring. Use when Codex needs to establish a baseline, evaluate an MCP/CLI/Squisq or prompt change, inspect generation traces and authored Markdown, explain static or LLM judge failures, create a paired A/B report, or decide the next evidence-backed authoring improvement.
---

# Run MCP Content Evals

Use the local harness as an experiment loop. Preserve the baseline, change one
owning boundary, rerun paired cases under the same conditions, and make claims from
the saved evidence.

Read [docs/mcp-evals.md](../../../docs/mcp-evals.md) before the first run in a
thread. Read `docs/mcp.md` when a hypothesis changes MCP behavior or protocol
contracts.

## Run a baseline

1. Inspect `git status --short`. Do not alter branches, worktrees, or commits.
2. Select `quick` for iteration or `full` for broader evidence. Pin `--model` for
   A/B work when a model ID is available.
3. Run `npm run eval:mcp -- run --suite quick --label baseline`. The command builds
   core and the CLI before hosting Codex with the built MCP.
4. Record the printed report directory. Treat `run.json`, `summary.md`, case
   `authored.md`, traces, and artifacts as the baseline evidence.

Use `--judge static` only when testing deterministic harness behavior or when Codex
judge access is intentionally unavailable. Do not compare a static-only run with a
run that used `both`.

## Diagnose results

Inspect evidence in this order:

- Required static failures in `summary.md` and the two static-judge JSON files.
- `authored.md` for missing facts, poor narrative, density, and template misuse.
- `generation-trace.jsonl` for tool selection, validation, preview, repair, and save
  behavior. Treat the traced final conversion Markdown as authoritative.
- The actual PPTX/DOCX package when a static result needs confirmation.
- LLM weaknesses across cases. Prefer repeated patterns over a single subjective
  comment.

Classify the likely owner before editing:

- Change Squisq when the format, templates, renderers, or authoring vocabulary are
  inadequate.
- Change DocBlocks MCP when discovery, tool contracts, validation, conversion
  policy, or server instructions are inadequate.
- Change the eval harness when capture, static checks, judge isolation, scoring, or
  reports are inadequate.
- Change a prompt profile only when explicitly evaluating prompt coaching.

Form one falsifiable hypothesis tied to named failing cases and metrics. Avoid
editing the rubric to make a candidate pass unless the rubric itself is
demonstrably wrong.

## Run and compare a candidate

1. Implement the narrowest change and run its focused tests.
2. Rerun the exact same suite or explicit case IDs, profile, judge mode, threshold,
   and model with a candidate label.
3. Run `npm run eval:mcp:run -- compare <baseline> <candidate>`.
4. Inspect per-case deltas and pass transitions. Flag regressions even when the
   aggregate improves.
5. Rerun material conclusions when the difference is small or only the LLM judge
   changed. Model grading is noisy; required static failures are deterministic.

Report the hypothesis, exact run directories, aggregate and per-case deltas,
remaining weaknesses, changed files, and verification. Do not claim native visual
fidelity from OOXML checks alone.

## Verification

Run harness-focused verification:

```bash
npm run test:eval:mcp
npm run typecheck -w @bendyline/docblocks-cli
npm run build:cli
```

For MCP or conversion behavior changes, also run the MCP gates required by
`docs/mcp.md`; use `npm run all` as the final repository assurance gate.
