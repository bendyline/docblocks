/**
 * `@bendyline/docblocks-bench`: the docbench task pack.
 *
 * The contract types are importable without side effects. Running the pack
 * goes through the `docbench-pack` command, which registers the DOM the
 * pipelines need before loading them; see `cli.ts`.
 */

export * from './contract.js';
