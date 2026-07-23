import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface WorkspaceManifest {
  readonly engines?: Readonly<Record<string, string>>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceManifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as WorkspaceManifest;

function readWorkspaceNodeEngine(): string {
  const value = workspaceManifest.engines?.node;
  if (!value) throw new Error('The root package.json must declare engines.node.');
  return value;
}

/**
 * The root manifest is the single source of truth for every published
 * DocBlocks package's Node runtime contract.
 */
export const WORKSPACE_NODE_ENGINE = readWorkspaceNodeEngine();

const baselineMatch = /^\^(\d+\.\d+\.\d+)(?:\s+\|\||$)/u.exec(WORKSPACE_NODE_ENGINE);
if (!baselineMatch?.[1]) {
  throw new Error(
    `The workspace Node engine must start with a caret baseline (received ${JSON.stringify(WORKSPACE_NODE_ENGINE)}).`,
  );
}

/** The exact Node release used by local development and CI. */
export const WORKSPACE_NODE_BASELINE = baselineMatch[1];

export const PUBLISHED_NODE_ENGINE_MANIFESTS = [
  'packages/core/package.json',
  'packages/react/package.json',
  'packages/cli/package.json',
] as const;
