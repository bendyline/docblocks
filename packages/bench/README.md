# @bendyline/docblocks-bench

The docbench task pack: DocBlocks' AI workloads (resume review, SVG
illustrations, slide suggestions, and more to come) as a model benchmark.

It runs the product's real pipelines from `@bendyline/docblocks-react/ai`
against any OpenAI-compatible endpoint and writes one outcome per case:
whether the product could use the reply, deterministic checks, the artifact,
and what a judge needs. Gezel's `eval:docbench` drives it, judges the
outcomes and computes the docbench score.

```bash
docbench-pack describe                       # the manifest: families, tasks, cases, rubrics
docbench-pack run --endpoint <url> --model <id> --out-dir <dir> [--trial n --seed n --now iso]
docbench-pack local --endpoint <url> --models a,b [--label name]   # checks-only dev loop
```

From the monorepo root, `npm run docbench -- <command>` runs it from source.
See [docs/docbench.md](../../docs/docbench.md) for the design, the contract and
how to add a task.
