import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type UnknownRecord = Readonly<Record<string, unknown>>;

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readPackage(relativePath: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8')) as PackageManifest;
}

async function workflowCommands(relativePath: string): Promise<readonly string[]> {
  const parsed: unknown = yaml.load(await readFile(path.join(repoRoot, relativePath), 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.jobs)) {
    throw new Error(`${relativePath}: workflow has no jobs map`);
  }
  const commands: string[] = [];
  for (const job of Object.values(parsed.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (isRecord(step) && typeof step.run === 'string') commands.push(step.run.trim());
    }
  }
  return commands;
}

function requireScript(manifest: PackageManifest, name: string, fragment: string): void {
  const value = manifest.scripts?.[name];
  if (!value?.includes(fragment)) {
    throw new Error(`package script ${name} must include ${fragment}`);
  }
}

function requireWorkflowScript(
  commands: readonly string[],
  script: string,
  workflow: string,
): void {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const invocation = new RegExp(`\\bnpm run ${escaped}(?=\\s|$)`, 'mu');
  if (!commands.some((command) => invocation.test(command))) {
    throw new Error(`${workflow} does not invoke npm run ${script}`);
  }
}

async function main(): Promise<void> {
  const rootPackage = await readPackage('package.json');
  const expectedGate = [
    'npm run build',
    'npm run bundle:size',
    'npm run check:desktop-config',
    'npm run check:packages',
    'npm run check:agent-guidance',
    'npm run check:assurance',
    'npm run lint',
    'npm run format:check',
    'npm run typecheck',
    'npm test',
  ];
  const actualGate = rootPackage.scripts?.all?.split(/\s*&&\s*/u) ?? [];
  if (JSON.stringify(actualGate) !== JSON.stringify(expectedGate)) {
    throw new Error(
      `root all script drifted\nexpected: ${expectedGate.join(' && ')}\nactual:   ${actualGate.join(' && ')}`,
    );
  }

  const vscodePackage = await readPackage('packages/vscode/package.json');
  requireScript(vscodePackage, 'typecheck', 'typecheck:extension');
  requireScript(vscodePackage, 'typecheck', 'typecheck:webview');

  const desktopPackage = await readPackage('packages/desktop/package.json');
  requireScript(desktopPackage, 'typecheck', 'tsconfig.e2e.json');
  requireScript(desktopPackage, 'test:e2e:packaged', 'dist:dir');
  requireScript(desktopPackage, 'test:e2e:packaged:only', 'playwright.packaged.config.ts');

  const workflowRequirements: Readonly<Record<string, readonly string[]>> = {
    '.github/workflows/ci.yml': [
      'all',
      'test:e2e',
      'test:e2e:offline',
      'test:e2e:desktop',
      'test:e2e:packaged:only',
      'test:e2e:vscode',
    ],
    '.github/workflows/publish.yml': ['all'],
    '.github/workflows/desktop-release.yml': ['all'],
    '.github/workflows/store-release.yml': ['all'],
  };
  for (const [workflow, requirements] of Object.entries(workflowRequirements)) {
    const commands = await workflowCommands(workflow);
    for (const requirement of requirements) {
      requireWorkflowScript(commands, requirement, workflow);
    }
  }

  const bundleCheck = await readFile(path.join(repoRoot, 'scripts/check-bundle-size.ts'), 'utf8');
  for (const requiredBudget of [
    'VS Code webview',
    'standalone editor source',
    'TypeScript worker',
    'aggregateBudget',
  ]) {
    if (!bundleCheck.includes(requiredBudget)) {
      throw new Error(`VS Code bundle assurance is missing ${requiredBudget}`);
    }
  }

  process.stdout.write(
    'Canonical gate, release workflows, E2E matrix, and shipped bundles agree.\n',
  );
}

await main();
