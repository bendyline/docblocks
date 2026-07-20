import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type UnknownRecord = Readonly<Record<string, unknown>>;

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, Readonly<{ optional?: boolean }>>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

interface PackageLock {
  readonly packages?: Readonly<Record<string, PackageManifest>>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readPackage(relativePath: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8')) as PackageManifest;
}

async function readPackageLock(): Promise<PackageLock> {
  return JSON.parse(
    await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'),
  ) as PackageLock;
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

async function requirePinnedWorkflowActions(relativePath: string): Promise<void> {
  const parsed: unknown = yaml.load(await readFile(path.join(repoRoot, relativePath), 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.jobs)) {
    throw new Error(`${relativePath}: workflow has no jobs map`);
  }
  for (const [jobName, job] of Object.entries(parsed.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!isRecord(step) || typeof step.uses !== 'string' || step.uses.startsWith('./')) continue;
      if (!/^[^@]+@[0-9a-f]{40}$/u.test(step.uses)) {
        throw new Error(
          `${relativePath}: ${jobName} action must use an immutable 40-character commit SHA: ${step.uses}`,
        );
      }
    }
  }
}

async function requirePrivateStoreReleaseWorkflow(relativePath: string): Promise<void> {
  const parsed: unknown = yaml.load(await readFile(path.join(repoRoot, relativePath), 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.jobs)) {
    throw new Error(`${relativePath}: workflow has no jobs map`);
  }

  const releaseTags = new Set<string>();
  const draftCreatorJobs = new Set<string>();
  const draftAssetUploadJobs = new Set<string>();
  let draftCreatorCount = 0;
  let draftAssetUploadCount = 0;

  for (const [jobName, job] of Object.entries(parsed.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!isRecord(step) || typeof step.uses !== 'string') continue;
      if (step.uses.startsWith('actions/upload-artifact@')) {
        throw new Error(
          `${relativePath}: ${jobName} exposes a directly downloadable workflow artifact`,
        );
      }
      if (!step.uses.startsWith('softprops/action-gh-release@')) continue;
      if (!isRecord(step.with) || step.with.draft !== true) {
        throw new Error(`${relativePath}: every GitHub Release step must set draft: true`);
      }
      if (typeof step.with.tag_name !== 'string') {
        throw new Error(`${relativePath}: every GitHub Release step must use an explicit tag`);
      }
      releaseTags.add(step.with.tag_name);
      if (typeof step.with.files === 'string') {
        draftAssetUploadCount += 1;
        draftAssetUploadJobs.add(jobName);
        if (step.with.fail_on_unmatched_files !== true) {
          throw new Error(`${relativePath}: draft asset uploads must fail when files are missing`);
        }
      } else {
        draftCreatorCount += 1;
        draftCreatorJobs.add(jobName);
        if (step.with.make_latest !== false) {
          throw new Error(
            `${relativePath}: the store draft must explicitly set make_latest: false`,
          );
        }
      }
    }
  }

  if (draftCreatorCount !== 1 || draftAssetUploadCount !== 2 || releaseTags.size !== 1) {
    throw new Error(
      `${relativePath}: expected one private draft creator and two uploads using the same tag`,
    );
  }

  if (
    !draftCreatorJobs.has('create-draft-release') ||
    !draftAssetUploadJobs.has('build-msix') ||
    !draftAssetUploadJobs.has('build-mas')
  ) {
    throw new Error(`${relativePath}: store builders must attach to create-draft-release`);
  }
  for (const jobName of ['create-draft-release', 'build-msix', 'build-mas']) {
    const job = parsed.jobs[jobName];
    if (!isRecord(job) || !isRecord(job.permissions) || job.permissions.contents !== 'write') {
      throw new Error(`${relativePath}: ${jobName} requires contents: write`);
    }
    if (jobName !== 'create-draft-release') {
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      if (!needs.includes('create-draft-release')) {
        throw new Error(`${relativePath}: ${jobName} must wait for the private draft`);
      }
    }
  }
}

function requireScript(manifest: PackageManifest, name: string, fragment: string): void {
  const value = manifest.scripts?.[name];
  if (!value?.includes(fragment)) {
    throw new Error(`package script ${name} must include ${fragment}`);
  }
}

function requireUnversionedWorkspaceDependency(
  manifest: PackageManifest,
  manifestPath: string,
  dependency: string,
): void {
  if (manifest.dependencies?.[dependency] !== '*') {
    throw new Error(
      `${manifestPath}: ${dependency} must use "*" because this workspace is excluded from semantic-release version updates`,
    );
  }
}

function requireWorkflowScript(
  commands: readonly string[],
  script: string,
  workflow: string,
): void {
  if (!invokesWorkflowScript(commands, script)) {
    throw new Error(`${workflow} does not invoke npm run ${script}`);
  }
}

function invokesWorkflowScript(commands: readonly string[], script: string): boolean {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const invocation = new RegExp(`\\bnpm run ${escaped}(?=\\s|$)`, 'mu');
  return commands.some((command) => invocation.test(command));
}

async function requireCanonicalGatePlaywrightBrowsers(relativePath: string): Promise<void> {
  const parsed: unknown = yaml.load(await readFile(path.join(repoRoot, relativePath), 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.jobs)) {
    throw new Error(`${relativePath}: workflow has no jobs map`);
  }

  for (const [jobName, job] of Object.entries(parsed.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    const commands = job.steps.flatMap((step) =>
      isRecord(step) && typeof step.run === 'string' ? [step.run.trim()] : [],
    );
    if (!invokesWorkflowScript(commands, 'all')) continue;

    const installCommand = commands.find((command) =>
      /\bnpx playwright install(?=\s|$)/mu.test(command),
    );
    const requiredArguments = ['--with-deps', 'chromium', 'firefox', 'webkit'];
    const missingArguments = requiredArguments.filter(
      (argument) =>
        !installCommand || !new RegExp(`(?:^|\\s)${argument}(?=\\s|$)`, 'mu').test(installCommand),
    );
    if (missingArguments.length > 0) {
      throw new Error(
        `${relativePath}: ${jobName} runs npm run all but its Playwright install is missing ${missingArguments.join(', ')}`,
      );
    }
  }
}

async function requireDesktopReleasePackaging(relativePath: string): Promise<void> {
  const parsed: unknown = yaml.load(await readFile(path.join(repoRoot, relativePath), 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.jobs)) {
    throw new Error(`${relativePath}: workflow has no jobs map`);
  }

  const vscodeJob = parsed.jobs['build-vscode-vsix'];
  if (!isRecord(vscodeJob) || !Array.isArray(vscodeJob.steps)) {
    throw new Error(`${relativePath}: build-vscode-vsix has no steps`);
  }
  const vscodeCommands = vscodeJob.steps.flatMap((step) =>
    isRecord(step) && typeof step.run === 'string' ? [step.run.trim()] : [],
  );
  const orderedCommands = vscodeCommands.join('\n');
  const buildCore = orderedCommands.indexOf('npm run build:core');
  const buildReact = orderedCommands.indexOf('npm run build:react');
  const packageVscode = orderedCommands.indexOf('npm run package:vsix -w docblocks-vscode');
  if (buildCore < 0 || buildReact <= buildCore || packageVscode <= buildReact) {
    throw new Error(
      `${relativePath}: build-vscode-vsix must build core and React before packaging the extension`,
    );
  }
  const vscodeVersionStep = vscodeJob.steps.find(
    (step) => isRecord(step) && step.name === 'Read release version',
  );
  if (
    !isRecord(vscodeVersionStep) ||
    vscodeVersionStep.id !== 'version' ||
    typeof vscodeVersionStep.run !== 'string' ||
    !vscodeVersionStep.run.includes("require('./packages/desktop/package.json').version") ||
    !vscodeVersionStep.run.includes('GITHUB_OUTPUT')
  ) {
    throw new Error(
      `${relativePath}: build-vscode-vsix must read the authoritative desktop release version`,
    );
  }
  const vscodePackageStep = vscodeJob.steps.find(
    (step) => isRecord(step) && step.name === 'Package VS Code extension',
  );
  if (
    !isRecord(vscodePackageStep) ||
    !isRecord(vscodePackageStep.env) ||
    vscodePackageStep.env.RELEASE_VERSION !== '${{ steps.version.outputs.version }}' ||
    typeof vscodePackageStep.run !== 'string' ||
    !vscodePackageStep.run.includes('npm run package:vsix -w docblocks-vscode') ||
    !vscodePackageStep.run.includes('"$RELEASE_VERSION"') ||
    !vscodePackageStep.run.includes('--no-update-package-json')
  ) {
    throw new Error(
      `${relativePath}: build-vscode-vsix must stamp the desktop version into the VSIX without changing the checkout`,
    );
  }

  const windowsJob = parsed.jobs['build-windows'];
  if (!isRecord(windowsJob) || !Array.isArray(windowsJob.steps)) {
    throw new Error(`${relativePath}: build-windows has no steps`);
  }
  const windowsPackageStep = windowsJob.steps.find(
    (step) => isRecord(step) && step.name === 'Build + package desktop (Windows)',
  );
  if (
    !isRecord(windowsPackageStep) ||
    windowsPackageStep['working-directory'] !== 'packages/desktop' ||
    typeof windowsPackageStep.run !== 'string' ||
    !windowsPackageStep.run.includes('electron-builder --win --publish never')
  ) {
    throw new Error(`${relativePath}: build-windows has no package step`);
  }
  const windowsVerifyStep = windowsJob.steps.find(
    (step) => isRecord(step) && step.name === 'Verify Windows signature (fail if unsigned)',
  );
  if (!isRecord(windowsVerifyStep) || typeof windowsVerifyStep.run !== 'string') {
    throw new Error(`${relativePath}: build-windows has no signature verification step`);
  }
  for (const requiredFragment of [
    "@('x64', 'arm64')",
    'Get-ChildItem packages/desktop/dist/artifacts/*.exe',
    'foreach ($installer in $installers)',
  ]) {
    if (!windowsVerifyStep.run.includes(requiredFragment)) {
      throw new Error(
        `${relativePath}: build-windows signature verification is missing ${requiredFragment}`,
      );
    }
  }

  const windowsUpdaterStepIndex = windowsJob.steps.findIndex(
    (step) => isRecord(step) && step.name === 'Prepare Windows updater manifest',
  );
  const windowsUploadStepIndex = windowsJob.steps.findIndex(
    (step) => isRecord(step) && step.name === 'Upload Windows artifacts',
  );
  const windowsUpdaterStep = windowsJob.steps[windowsUpdaterStepIndex];
  if (
    windowsUpdaterStepIndex <= windowsJob.steps.indexOf(windowsVerifyStep) ||
    windowsUploadStepIndex <= windowsUpdaterStepIndex ||
    !isRecord(windowsUpdaterStep) ||
    typeof windowsUpdaterStep.run !== 'string' ||
    !windowsUpdaterStep.run.includes('npm run prepare:windows-updater -w docblocks-desktop')
  ) {
    throw new Error(
      relativePath +
        ': build-windows must normalize updater metadata after signing and before upload',
    );
  }
  const linuxJob = parsed.jobs['build-linux'];
  if (!isRecord(linuxJob) || !Array.isArray(linuxJob.steps)) {
    throw new Error(`${relativePath}: build-linux has no steps`);
  }
  const linuxVerifyStep = linuxJob.steps.find(
    (step) => isRecord(step) && step.name === 'Verify Linux architecture artifacts',
  );
  if (!isRecord(linuxVerifyStep) || typeof linuxVerifyStep.run !== 'string') {
    throw new Error(`${relativePath}: build-linux has no artifact verification step`);
  }
  for (const requiredFragment of [
    '*-linux-x86_64.AppImage',
    '*-linux-arm64.AppImage',
    '*-linux-amd64.deb',
    '*-linux-arm64.deb',
    'latest-linux-arm64.yml',
  ]) {
    if (!linuxVerifyStep.run.includes(requiredFragment)) {
      throw new Error(
        `${relativePath}: build-linux artifact verification is missing ${requiredFragment}`,
      );
    }
  }
  const linuxUploadStep = linuxJob.steps.find(
    (step) => isRecord(step) && step.name === 'Upload Linux artifacts',
  );
  if (
    !isRecord(linuxUploadStep) ||
    !isRecord(linuxUploadStep.with) ||
    typeof linuxUploadStep.with.path !== 'string' ||
    !linuxUploadStep.with.path.includes('latest-linux-arm64.yml')
  ) {
    throw new Error(`${relativePath}: build-linux must upload the arm64 updater manifest`);
  }

  const macJob = parsed.jobs['build-macos'];
  if (!isRecord(macJob) || macJob['runs-on'] !== 'macos-15' || !Array.isArray(macJob.steps)) {
    throw new Error(`${relativePath}: build-macos must stay pinned to macos-15`);
  }
  const macPackageStep = macJob.steps.find(
    (step) => isRecord(step) && step.name === 'Build + package desktop (macOS)',
  );
  if (
    !isRecord(macPackageStep) ||
    macPackageStep['working-directory'] !== 'packages/desktop' ||
    typeof macPackageStep.run !== 'string'
  ) {
    throw new Error(`${relativePath}: build-macos has no package step`);
  }
  for (const requiredFragment of [
    'electron-builder --mac --publish never',
    'max_attempts=3',
    'A timestamp was expected but was not found.',
    'rm -rf dist/artifacts',
  ]) {
    if (!macPackageStep.run.includes(requiredFragment)) {
      throw new Error(`${relativePath}: build-macos package step is missing ${requiredFragment}`);
    }
  }
}

async function main(): Promise<void> {
  const rootPackage = await readPackage('package.json');
  const expectedGate = [
    'npm run build',
    'npm run bundle:size',
    'npm run check:site-precache',
    'npm run check:site-fonts',
    'npm run check:desktop-config',
    'npm run check:vscode-package',
    'npm run check:notices',
    'npm run check:agent-guidance',
    'npm run check:assurance',
    'npm run lint',
    'npm run format:check',
    'npm run typecheck',
    'npm run check:packages',
    'npm run coverage:critical',
    'npm test',
    'npm run test:e2e:all',
  ];
  const actualGate = rootPackage.scripts?.all?.split(/\s*&&\s*/u) ?? [];
  if (JSON.stringify(actualGate) !== JSON.stringify(expectedGate)) {
    throw new Error(
      `root all script drifted\nexpected: ${expectedGate.join(' && ')}\nactual:   ${actualGate.join(' && ')}`,
    );
  }
  for (const requiredSuite of [
    'test:e2e',
    'test:e2e:browsers',
    'test:e2e:offline',
    'test:e2e:vscode',
    'test:e2e:vscode:desktop',
    'test:e2e:desktop',
    'test:e2e:desktop:packaged',
  ]) {
    requireScript(rootPackage, 'test:e2e:all', `npm run ${requiredSuite}`);
  }

  const vscodePackage = await readPackage('packages/vscode/package.json');
  requireScript(rootPackage, 'check:vscode-package', 'check:package-contents -w docblocks-vscode');
  requireScript(vscodePackage, 'package:vsix', 'npm run check:package-contents');
  requireScript(vscodePackage, 'check:package-contents', 'check-vscode-package-contents.ts');
  requireScript(vscodePackage, 'typecheck', 'typecheck:extension');
  requireScript(vscodePackage, 'typecheck', 'typecheck:webview');
  requireScript(vscodePackage, 'typecheck', 'typecheck:desktop-e2e');
  requireScript(vscodePackage, 'test:e2e:desktop-host', 'desktop-e2e/run.ts');
  requireScript(rootPackage, 'coverage:critical', 'coverage:desktop-critical');
  requireScript(rootPackage, 'coverage:critical', 'coverage:core-critical');
  for (const dependency of ['@bendyline/docblocks', '@bendyline/docblocks-react']) {
    requireUnversionedWorkspaceDependency(
      vscodePackage,
      'packages/vscode/package.json',
      dependency,
    );
  }

  const desktopPackage = await readPackage('packages/desktop/package.json');
  requireScript(desktopPackage, 'typecheck', 'tsconfig.e2e.json');
  requireScript(desktopPackage, 'test:e2e:packaged', 'dist:dir');
  requireScript(desktopPackage, 'test:e2e:packaged:only', 'playwright.packaged.config.ts');
  requireScript(desktopPackage, 'dist:dir', '-c.mac.hardenedRuntime=false');

  const reactPackage = await readPackage('packages/react/package.json');
  const sitePackage = await readPackage('packages/site/package.json');
  const packageLock = await readPackageLock();
  const expectedMonacoVersion = '0.50.0';
  if (reactPackage.peerDependencies?.['monaco-editor'] !== undefined) {
    throw new Error('packages/react must leave Monaco peer ownership to Squisq');
  }
  const lockedSquisqEditor = packageLock.packages?.['node_modules/@bendyline/squisq-editor-react'];
  if (
    lockedSquisqEditor?.peerDependencies?.['monaco-editor'] !== `~${expectedMonacoVersion}` ||
    lockedSquisqEditor.peerDependenciesMeta?.['monaco-editor']?.optional === true
  ) {
    throw new Error(
      `package-lock.json must resolve @bendyline/squisq-editor-react with a required monaco-editor ~${expectedMonacoVersion} peer`,
    );
  }
  for (const [manifestPath, manifest] of [
    ['package.json', rootPackage],
    ['packages/react/package.json', reactPackage],
    ['packages/site/package.json', sitePackage],
    ['packages/desktop/package.json', desktopPackage],
    ['packages/vscode/package.json', vscodePackage],
  ] as const) {
    const declaredVersion =
      manifest.dependencies?.['monaco-editor'] ?? manifest.devDependencies?.['monaco-editor'];
    if (declaredVersion !== expectedMonacoVersion) {
      throw new Error(`${manifestPath}: monaco-editor must be ${expectedMonacoVersion}`);
    }
  }

  const workflowRequirements: Readonly<Record<string, readonly string[]>> = {
    '.github/workflows/ci.yml': [
      'all',
      'test:e2e',
      'test:e2e:browsers',
      'test:e2e:offline',
      'test:e2e:desktop',
      'test:e2e:packaged:only',
      'test:e2e:vscode',
      'test:e2e:vscode:desktop',
    ],
    '.github/workflows/publish.yml': ['all'],
    '.github/workflows/desktop-release.yml': ['all'],
    '.github/workflows/store-release.yml': ['all'],
    '.github/workflows/vscode-release.yml': ['all'],
  };
  for (const [workflow, requirements] of Object.entries(workflowRequirements)) {
    const commands = await workflowCommands(workflow);
    for (const requirement of requirements) {
      requireWorkflowScript(commands, requirement, workflow);
    }
    await requirePinnedWorkflowActions(workflow);
    await requireCanonicalGatePlaywrightBrowsers(workflow);
  }
  await requirePrivateStoreReleaseWorkflow('.github/workflows/store-release.yml');
  await requireDesktopReleasePackaging('.github/workflows/desktop-release.yml');

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
    'Canonical all-tests gate, release workflows, E2E matrix, and shipped bundles agree.\n',
  );
}

await main();
