/**
 * Verify that DocBlocks is exercising the sibling Squisq checkout and that
 * its MCP format manifest accounts for every capability in Squisq's CLI
 * registry.
 *
 * This is deliberately separate from check-squisq-links.ts: that preflight
 * validates declarations when links happen to be present, while this check is
 * an explicit assurance gate that requires the links to be present.
 */

import { execFile } from 'node:child_process';
import { realpath, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EXPECTED_SQUISQ_PACKAGES = new Map<string, string>([
  ['@bendyline/squisq', 'core'],
  ['@bendyline/squisq-react', 'react'],
  ['@bendyline/squisq-editor-react', 'editor-react'],
  ['@bendyline/squisq-formats', 'formats'],
  ['@bendyline/squisq-video', 'video'],
  ['@bendyline/squisq-video-react', 'video-react'],
  ['@bendyline/squisq-cli', 'cli'],
]);

export interface McpCapabilityDirection {
  supported: boolean;
  tool?: string;
  excludedReason?: string;
}

/**
 * Expected shape of packages/cli/src/mcp/server.ts's exported manifest.
 *
 * A supported Squisq direction must either be exposed by an MCP tool or carry
 * an explicit exclusion reason. This makes linked API growth fail closed.
 */
export interface McpFormatCapability {
  id: string;
  label: string;
  mimeType: string;
  extensions: readonly string[];
  import: McpCapabilityDirection;
  export: McpCapabilityDirection;
}

export interface RegistryFormatCapability {
  id: string;
  label: string;
  mimeType: string;
  extensions: readonly string[];
  canImport: boolean;
  canExport: boolean;
}

export interface LinkedSquisqCheckResult {
  commit: string;
  dirtyFingerprint: string | null;
  packages: ReadonlyArray<{ name: string; realPath: string }>;
  formats: readonly RegistryFormatCapability[];
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(normalizePath(parent), normalizePath(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function isSquisqPackageName(name: string): boolean {
  return name === 'squisq' || name.startsWith('squisq-');
}

function stringArrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function describeDirection(direction: 'import' | 'export'): string {
  return direction === 'import' ? 'input' : 'output';
}

function checkExposure(
  entry: McpFormatCapability,
  direction: 'import' | 'export',
  issues: string[],
): void {
  const capability = entry[direction];
  const hasTool = typeof capability.tool === 'string' && capability.tool.trim().length > 0;
  const hasExclusion =
    typeof capability.excludedReason === 'string' && capability.excludedReason.trim().length > 0;

  if (!capability.supported) {
    if (hasTool) {
      issues.push(
        `${entry.id}: unsupported ${describeDirection(direction)} declares tool ${capability.tool}`,
      );
    }
    return;
  }

  if (hasTool === hasExclusion) {
    issues.push(
      `${entry.id}: supported ${describeDirection(direction)} must declare exactly one of tool or excludedReason`,
    );
  }
  const expectedTool = direction === 'import' ? 'inspect_document' : 'convert_document';
  if (hasTool && capability.tool !== expectedTool) {
    issues.push(
      `${entry.id}: supported ${describeDirection(direction)} must use canonical tool ${expectedTool}`,
    );
  }
}

export function compareFormatCapabilities(
  registryFormats: readonly RegistryFormatCapability[],
  manifest: readonly McpFormatCapability[],
  conversionTargetFormats?: readonly string[],
): string[] {
  const issues: string[] = [];
  const registryById = new Map(registryFormats.map((format) => [format.id, format]));
  const manifestById = new Map<string, McpFormatCapability>();

  for (const entry of manifest) {
    if (manifestById.has(entry.id)) {
      issues.push(`duplicate MCP format manifest entry: ${entry.id}`);
    }
    manifestById.set(entry.id, entry);
  }

  for (const format of registryFormats) {
    const entry = manifestById.get(format.id);
    if (!entry) {
      issues.push(`linked Squisq format is absent from MCP manifest: ${format.id}`);
      continue;
    }

    if (entry.label !== format.label) {
      issues.push(
        `${format.id}: label differs (Squisq=${JSON.stringify(format.label)}, MCP=${JSON.stringify(entry.label)})`,
      );
    }
    if (entry.mimeType !== format.mimeType) {
      issues.push(
        `${format.id}: MIME type differs (Squisq=${JSON.stringify(format.mimeType)}, MCP=${JSON.stringify(entry.mimeType)})`,
      );
    }
    if (!stringArrayEqual(entry.extensions, format.extensions)) {
      issues.push(
        `${format.id}: extensions differ (Squisq=${JSON.stringify(format.extensions)}, MCP=${JSON.stringify(entry.extensions)})`,
      );
    }
    if (entry.import.supported !== format.canImport) {
      issues.push(
        `${format.id}: import support differs (Squisq=${format.canImport}, MCP=${entry.import.supported})`,
      );
    }
    if (entry.export.supported !== format.canExport) {
      issues.push(
        `${format.id}: export support differs (Squisq=${format.canExport}, MCP=${entry.export.supported})`,
      );
    }

    checkExposure(entry, 'import', issues);
    checkExposure(entry, 'export', issues);
  }

  for (const entry of manifest) {
    if (!registryById.has(entry.id)) {
      issues.push(`MCP manifest contains a format absent from linked Squisq: ${entry.id}`);
    }
  }

  if (conversionTargetFormats) {
    const targetSet = new Set<string>();
    for (const format of conversionTargetFormats) {
      if (targetSet.has(format)) issues.push(`duplicate convert_document target format: ${format}`);
      targetSet.add(format);
    }
    for (const format of registryFormats) {
      if (format.canExport && !targetSet.has(format.id)) {
        issues.push(
          `linked Squisq export format is not accepted by convert_document: ${format.id}`,
        );
      }
    }
    for (const format of targetSet) {
      const registry = registryById.get(format);
      if (!registry) {
        issues.push(`convert_document accepts a format absent from linked Squisq: ${format}`);
      } else if (!registry.canExport) {
        issues.push(`convert_document accepts linked import-only format: ${format}`);
      }
    }
  }

  return issues;
}

function isDirection(value: unknown): value is McpCapabilityDirection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.supported === 'boolean' &&
    (candidate.tool === undefined || typeof candidate.tool === 'string') &&
    (candidate.excludedReason === undefined || typeof candidate.excludedReason === 'string')
  );
}

function isMcpFormatCapability(value: unknown): value is McpFormatCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.mimeType === 'string' &&
    Array.isArray(candidate.extensions) &&
    candidate.extensions.every((extension) => typeof extension === 'string') &&
    isDirection(candidate.import) &&
    isDirection(candidate.export)
  );
}

function parseManifest(value: unknown): readonly McpFormatCapability[] {
  if (!Array.isArray(value) || !value.every(isMcpFormatCapability)) {
    throw new Error(
      'MCP_FORMAT_CAPABILITIES must be an array of ' +
        '{ id, label, mimeType, extensions, import: { supported, tool?, excludedReason? }, ' +
        'export: { supported, tool?, excludedReason? } } entries',
    );
  }
  return value;
}

function parseConversionTargetFormats(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (format) => typeof format === 'string' && /^[a-z0-9][a-z0-9.+_-]{0,63}$/u.test(format),
    )
  ) {
    throw new Error('MCP_CONVERSION_TARGET_FORMATS must be an array of canonical format ids');
  }
  return value;
}

async function discoverLinkedPackages(
  docblocksRoot: string,
  squisqPackagesRoot: string,
): Promise<ReadonlyArray<{ name: string; realPath: string }>> {
  const namespaceDirectory = path.join(docblocksRoot, 'node_modules', '@bendyline');
  const installedEntries = await readdir(namespaceDirectory, { withFileTypes: true });
  const discoveredNames = installedEntries
    .map(({ name }) => name)
    .filter(isSquisqPackageName)
    .map((name) => `@bendyline/${name}`);
  const packageNames = [
    ...new Set([...EXPECTED_SQUISQ_PACKAGES.keys(), ...discoveredNames]),
  ].sort();
  const linked: Array<{ name: string; realPath: string }> = [];
  const issues: string[] = [];

  for (const packageName of packageNames) {
    const packageDirectory = path.join(docblocksRoot, 'node_modules', ...packageName.split('/'));
    let resolved: string;
    try {
      resolved = await realpath(packageDirectory);
    } catch (caught: unknown) {
      issues.push(
        `${packageName}: package cannot be resolved (${caught instanceof Error ? caught.message : String(caught)})`,
      );
      continue;
    }

    if (!isPathInside(squisqPackagesRoot, resolved)) {
      issues.push(`${packageName}: resolves outside sibling Squisq packages (${resolved})`);
      continue;
    }

    const expectedDirectory = EXPECTED_SQUISQ_PACKAGES.get(packageName);
    if (expectedDirectory) {
      const expectedPath = await realpath(path.join(squisqPackagesRoot, expectedDirectory));
      if (normalizePath(expectedPath) !== normalizePath(resolved)) {
        issues.push(`${packageName}: resolves to ${resolved}, expected ${expectedPath}`);
        continue;
      }
    }

    linked.push({ name: packageName, realPath: resolved });
  }

  if (issues.length > 0) {
    throw new Error(
      `DocBlocks is not using the complete sibling Squisq checkout:\n${issues.map((issue) => `  - ${issue}`).join('\n')}\n` +
        'Run npm run link:squisq before this assurance check.',
    );
  }

  return linked;
}

async function readSquisqCommit(squisqRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', `safe.directory=${squisqRoot}`, '-C', squisqRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`Unexpected Squisq git commit: ${JSON.stringify(commit)}`);
  }
  return commit;
}

async function readDirtyFingerprint(squisqRoot: string): Promise<string | null> {
  const gitOptions = {
    encoding: 'utf8' as const,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  };
  const [{ stdout: statusOutput }, { stdout: diffOutput }] = await Promise.all([
    execFileAsync(
      'git',
      [
        '-c',
        `safe.directory=${squisqRoot}`,
        '-C',
        squisqRoot,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--',
        'packages',
      ],
      gitOptions,
    ),
    execFileAsync(
      'git',
      [
        '-c',
        `safe.directory=${squisqRoot}`,
        '-C',
        squisqRoot,
        'diff',
        '--binary',
        '--no-ext-diff',
        'HEAD',
        '--',
        'packages',
      ],
      gitOptions,
    ),
  ]);
  const statusText = statusOutput.trim();
  if (!statusText) return null;
  return createHash('sha256').update(statusText).update('\0').update(diffOutput).digest('hex');
}

async function assertLinkedBuildsAreFresh(
  packages: ReadonlyArray<{ name: string; realPath: string }>,
): Promise<void> {
  const issues: string[] = [];
  for (const linkedPackage of packages) {
    const sourceTime = await latestFileTime(path.join(linkedPackage.realPath, 'src'));
    const distTime = await latestFileTime(path.join(linkedPackage.realPath, 'dist'));
    if (sourceTime === null || distTime === null || sourceTime > distTime + 1_000) {
      issues.push(
        `${linkedPackage.name}: linked dist is missing or older than source; run npm run build:squisq-linked`,
      );
    }
  }
  if (issues.length > 0) {
    throw new Error(
      `Linked Squisq build freshness failed:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
  }
}

async function latestFileTime(directory: string): Promise<number | null> {
  const pending = [directory];
  let latest: number | null = null;
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > 20_000)
        throw new Error(`Linked build tree is unexpectedly large: ${directory}`);
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) {
        const modified = (await stat(candidate)).mtimeMs;
        latest = latest === null ? modified : Math.max(latest, modified);
      }
    }
  }
  return latest;
}

export async function checkLinkedSquisq(
  docblocksRoot = path.resolve(import.meta.dirname, '..'),
): Promise<LinkedSquisqCheckResult> {
  const squisqRoot = path.resolve(docblocksRoot, '..', 'squisq');
  const squisqPackagesRoot = path.join(squisqRoot, 'packages');
  const packages = await discoverLinkedPackages(docblocksRoot, squisqPackagesRoot);
  const commit = await readSquisqCommit(squisqRoot);
  const dirtyFingerprint = await readDirtyFingerprint(squisqRoot);
  await assertLinkedBuildsAreFresh(packages);

  const [{ createCliRegistry }, mcpModule] = await Promise.all([
    import('@bendyline/squisq-cli/api'),
    import('../packages/cli/src/mcp/server.js'),
  ]);
  const moduleRecord = mcpModule as Record<string, unknown>;
  if (!('MCP_FORMAT_CAPABILITIES' in moduleRecord)) {
    throw new Error(
      'packages/cli/src/mcp/server.ts must export MCP_FORMAT_CAPABILITIES for linked API assurance',
    );
  }
  if (!('MCP_CONVERSION_TARGET_FORMATS' in moduleRecord)) {
    throw new Error(
      'packages/cli/src/mcp/server.ts must export MCP_CONVERSION_TARGET_FORMATS for linked API assurance',
    );
  }

  const registryFormats: RegistryFormatCapability[] = createCliRegistry()
    .list()
    .map((format) => ({
      id: format.id,
      label: format.label,
      mimeType: format.mimeType,
      extensions: [...format.extensions],
      canImport:
        typeof format.importDoc === 'function' || typeof format.importContainer === 'function',
      canExport: typeof format.exportDoc === 'function',
    }));
  const manifest = parseManifest(moduleRecord.MCP_FORMAT_CAPABILITIES);
  const conversionTargetFormats = parseConversionTargetFormats(
    moduleRecord.MCP_CONVERSION_TARGET_FORMATS,
  );
  const issues = compareFormatCapabilities(registryFormats, manifest, conversionTargetFormats);
  if (issues.length > 0) {
    throw new Error(
      `DocBlocks MCP format capabilities drifted from linked Squisq:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
  }

  return { commit, dirtyFingerprint, packages, formats: registryFormats };
}

async function main(): Promise<void> {
  const result = await checkLinkedSquisq();
  console.warn(`Linked Squisq commit: ${result.commit}`);
  console.warn(
    result.dirtyFingerprint
      ? `Linked Squisq working-tree fingerprint: ${result.dirtyFingerprint}`
      : 'Linked Squisq working tree: clean',
  );
  for (const linkedPackage of result.packages) {
    console.warn(`  ${linkedPackage.name} -> ${linkedPackage.realPath}`);
  }
  console.warn(
    `MCP format manifest accounts for all ${result.formats.length} linked Squisq formats.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((caught: unknown) => {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  });
}
