import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatWithPrettier } from 'prettier';

interface LockPackage {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly license?: string;
  readonly link?: boolean;
  readonly resolved?: string;
  readonly version?: string;
}

interface PackageLock {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockPackage>>;
}

interface PackageManifest {
  readonly author?: unknown;
  readonly homepage?: unknown;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly name?: unknown;
  readonly repository?: unknown;
  readonly version?: unknown;
}

interface ArtifactComponent {
  readonly name: string;
  readonly version: string;
}

interface ArtifactManifest {
  readonly schemaVersion: number;
  readonly components: readonly ArtifactComponent[];
}

interface Component extends ArtifactComponent {
  readonly license: string;
  readonly lockKey: string;
  readonly repository: string;
}

interface LicenseMaterial {
  readonly content: string;
  readonly packages: Set<string>;
  readonly sources: Set<string>;
}

interface LicenseMaterialCollection {
  readonly materials: readonly LicenseMaterial[];
  readonly missing: readonly Component[];
}

interface Surface {
  readonly artifactManifest?: string;
  readonly description: string;
  readonly id: string;
  readonly optionalDependencyNames?: ReadonlySet<string> | 'all';
  readonly output: string;
  readonly supplementalPackages?: readonly string[];
  readonly title: string;
  readonly workspace?: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(repoRoot, 'package-lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8')) as PackageLock;
if (lock.lockfileVersion !== 3 || !lock.packages) {
  throw new Error('Third-party notices require package-lock.json lockfileVersion 3.');
}
const lockPackages = lock.packages;

const FIRST_PARTY_PACKAGES = new Set([
  'docblocks',
  'docblocks-desktop',
  'docblocks-site',
  'docblocks-vscode',
  '@bendyline/docblocks',
  '@bendyline/docblocks-cli',
  '@bendyline/docblocks-react',
]);

const surfaces: readonly Surface[] = [
  {
    id: 'npm-core',
    title: '@bendyline/docblocks npm package',
    description:
      'Resolved runtime and optional dependency closure declared by packages/core/package.json.',
    workspace: 'packages/core',
    optionalDependencyNames: 'all',
    output: 'packages/core/THIRD_PARTY_NOTICES.txt',
  },
  {
    id: 'npm-react',
    title: '@bendyline/docblocks-react npm package',
    description:
      'Resolved runtime and optional dependency closure declared by packages/react/package.json. Peer dependencies are supplied by the consuming application and are not included.',
    workspace: 'packages/react',
    optionalDependencyNames: 'all',
    output: 'packages/react/THIRD_PARTY_NOTICES.txt',
  },
  {
    id: 'npm-cli',
    title: '@bendyline/docblocks-cli npm package',
    description:
      'Resolved runtime and optional dependency closure declared by packages/cli/package.json.',
    workspace: 'packages/cli',
    optionalDependencyNames: 'all',
    output: 'packages/cli/THIRD_PARTY_NOTICES.txt',
  },
  {
    id: 'site',
    title: 'DocBlocks site distribution',
    description:
      'Packages present in the emitted Vite/Rollup module graph, plus the copied ffmpeg.wasm, harper.js, and IronCalc WebAssembly engines and Workbox service-worker components.',
    artifactManifest: 'packages/site/dist/THIRD_PARTY_COMPONENTS.json',
    supplementalPackages: [
      '@ffmpeg/core',
      '@ironcalc/wasm',
      'harper.js',
      'workbox-core',
      'workbox-precaching',
      'workbox-routing',
      'workbox-strategies',
    ],
    output: 'packages/site/public/THIRD_PARTY_NOTICES.txt',
  },
  {
    id: 'vscode',
    title: 'DocBlocks VS Code extension (VSIX)',
    description:
      'Packages present in the emitted webview Vite/Rollup module graph, plus the copied harper.js and IronCalc WebAssembly engines and jsonc-parser bundled into the desktop and web extension-host entry points.',
    artifactManifest: 'packages/vscode/dist/webview/THIRD_PARTY_COMPONENTS.json',
    supplementalPackages: ['@ironcalc/wasm', 'harper.js', 'jsonc-parser'],
    output: 'packages/vscode/THIRD_PARTY_NOTICES.txt',
  },
  {
    id: 'desktop',
    title: 'DocBlocks desktop distribution',
    description:
      'Packages present in the emitted renderer Vite/Rollup module graph, plus the copied harper.js and IronCalc WebAssembly engines, Electron itself, and the production dependencies copied beside the bundled main process.',
    artifactManifest: 'packages/desktop/dist/renderer/THIRD_PARTY_COMPONENTS.json',
    workspace: 'packages/desktop',
    optionalDependencyNames: new Set(['fsevents']),
    supplementalPackages: ['@ironcalc/wasm', 'electron', 'harper.js'],
    output: 'packages/desktop/THIRD_PARTY_NOTICES.txt',
  },
];

function normalizeLockKey(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}

function canonicalLockKey(lockKey: string): string {
  const entry = lockPackages[lockKey];
  if (!entry) throw new Error(`package-lock.json has no entry for ${lockKey}`);
  if (!entry.link) return lockKey;
  if (!entry.resolved) throw new Error(`package-lock.json link ${lockKey} has no resolved target`);
  const target = normalizeLockKey(entry.resolved);
  if (!lockPackages[target]) {
    throw new Error(`package-lock.json link ${lockKey} resolves to missing ${target}`);
  }
  return target;
}

function packageNameFromLockKey(lockKey: string): string | null {
  const marker = 'node_modules/';
  const markerIndex = lockKey.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const tail = lockKey.slice(markerIndex + marker.length);
  const parts = tail.split('/');
  return tail.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] || null;
}

function resolveDependency(parentKey: string, packageName: string): string {
  let current = normalizeLockKey(parentKey);
  while (true) {
    const candidate = current
      ? `${current}/node_modules/${packageName}`
      : `node_modules/${packageName}`;
    if (lockPackages[candidate]) return canonicalLockKey(candidate);
    if (!current) break;
    const parent = path.posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
  throw new Error(`Cannot resolve ${packageName} from ${parentKey || 'the repository root'}`);
}

function dependencyClosure(
  workspace: string,
  optionalDependencyNames: ReadonlySet<string> | 'all' | undefined,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  const enqueueDependencies = (parentKey: string): void => {
    const entry = lockPackages[parentKey];
    if (!entry) throw new Error(`Missing lockfile package ${parentKey}`);
    for (const name of Object.keys(entry.dependencies ?? {})) {
      queue.push(resolveDependency(parentKey, name));
    }
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      if (optionalDependencyNames === 'all' || optionalDependencyNames?.has(name)) {
        queue.push(resolveDependency(parentKey, name));
      }
    }
  };

  enqueueDependencies(workspace);
  while (queue.length > 0) {
    const lockKey = queue.shift();
    if (!lockKey || visited.has(lockKey)) continue;
    visited.add(lockKey);
    enqueueDependencies(lockKey);
  }
  return visited;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArtifactManifest(value: unknown, source: string): ArtifactManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.components)) {
    throw new Error(`${source} is not a third-party component manifest (schema version 1).`);
  }
  const components: ArtifactComponent[] = [];
  for (const item of value.components) {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => key !== 'name' && key !== 'version') ||
      typeof item.name !== 'string' ||
      typeof item.version !== 'string'
    ) {
      throw new Error(`${source} contains an invalid component entry.`);
    }
    components.push({ name: item.name, version: item.version });
  }
  return { schemaVersion: 1, components };
}

async function artifactComponents(relativePath: string): Promise<readonly ArtifactComponent[]> {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`${relativePath} is missing; run npm run build before generating notices.`);
  }
  const parsed: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));
  return validateArtifactManifest(parsed, relativePath).components;
}

function lockKeysForIdentity(name: string, version: string): readonly string[] {
  return Object.entries(lockPackages)
    .filter(
      ([lockKey, entry]) =>
        !entry.link && packageNameFromLockKey(lockKey) === name && entry.version === version,
    )
    .map(([lockKey]) => lockKey)
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
}

function rootLockKey(packageName: string): string {
  return canonicalLockKey(resolveDependency('', packageName));
}

function readManifest(lockKey: string): PackageManifest | null {
  const manifestPath = path.join(repoRoot, lockKey, 'package.json');
  if (!existsSync(manifestPath)) return null;
  const parsed: unknown = JSON.parse(readdirSafeFile(manifestPath));
  return isRecord(parsed) ? (parsed as PackageManifest) : null;
}

function readdirSafeFile(filePath: string): string {
  const size = statSync(filePath).size;
  if (size > 4 * 1024 * 1024) throw new Error(`${filePath} exceeds the metadata read budget.`);
  return readFileSync(filePath, 'utf8');
}

function manifestLicense(manifest: PackageManifest | null): string | null {
  if (typeof manifest?.license === 'string' && manifest.license.trim())
    return manifest.license.trim();
  if (!Array.isArray(manifest?.licenses)) return null;
  const types = manifest.licenses
    .map((item: unknown) => (isRecord(item) && typeof item.type === 'string' ? item.type : null))
    .filter((item: string | null): item is string => Boolean(item));
  return types.length > 0 ? types.join(' OR ') : null;
}

function repositoryUrl(manifest: PackageManifest | null, name: string): string {
  const repository = manifest?.repository;
  const raw =
    typeof repository === 'string'
      ? repository
      : isRecord(repository) && typeof repository.url === 'string'
        ? repository.url
        : typeof manifest?.homepage === 'string'
          ? manifest.homepage
          : null;
  if (!raw) return `https://www.npmjs.com/package/${name}`;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(raw)) return `https://github.com/${raw}`;
  return raw
    .replace(/^git\+https:/u, 'https:')
    .replace(/^git:\/\/github\.com\//u, 'https://github.com/')
    .replace(/\.git$/u, '');
}

function componentFromLockKey(lockKey: string): Component | null {
  const canonicalKey = canonicalLockKey(lockKey);
  const lockEntry = lockPackages[canonicalKey];
  if (!lockEntry) throw new Error(`Missing lockfile package ${canonicalKey}`);
  const name = packageNameFromLockKey(canonicalKey);
  if (!name || FIRST_PARTY_PACKAGES.has(name)) return null;
  if (!lockEntry.version) throw new Error(`${canonicalKey} has no locked version.`);
  const manifest = readManifest(canonicalKey);
  const license =
    lockEntry.license ?? manifestLicense(manifest) ?? (name === 'khroma' ? 'MIT' : null);
  if (!license) throw new Error(`${name}@${lockEntry.version} has no declared license.`);
  return {
    name,
    version: lockEntry.version,
    license,
    lockKey: canonicalKey,
    repository: repositoryUrl(manifest, name),
  };
}

function componentFromIdentity(identity: ArtifactComponent): Component {
  const keys = lockKeysForIdentity(identity.name, identity.version);
  if (keys.length === 0) {
    throw new Error(
      `Built artifact contains ${identity.name}@${identity.version}, which is absent from package-lock.json.`,
    );
  }
  const component = componentFromLockKey(keys[0]);
  if (!component) throw new Error(`Artifact manifest unexpectedly includes ${identity.name}.`);
  return component;
}

async function componentsForSurface(surface: Surface): Promise<readonly Component[]> {
  const byIdentity = new Map<string, Component>();
  const add = (component: Component | null): void => {
    if (component) byIdentity.set(`${component.name}@${component.version}`, component);
  };

  if (surface.workspace) {
    for (const lockKey of dependencyClosure(surface.workspace, surface.optionalDependencyNames)) {
      add(componentFromLockKey(lockKey));
    }
  }
  if (surface.artifactManifest) {
    for (const identity of await artifactComponents(surface.artifactManifest)) {
      add(componentFromIdentity(identity));
    }
  }
  for (const packageName of surface.supplementalPackages ?? []) {
    add(componentFromLockKey(rootLockKey(packageName)));
  }

  return [...byIdentity.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

const licenseFilePattern =
  /^(?:licen[cs]e|copying|notice|third[_-]party(?:[_-]licenses)?)(?:[._-].*)?$/iu;

function packageLicenseFiles(component: Component): readonly string[] {
  const directory = path.join(repoRoot, component.lockKey);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function fallbackLicenseFiles(component: Component): readonly string[] {
  if (component.name.startsWith('@tiptap/')) {
    return ['node_modules/@bendyline/squisq-editor-react/THIRD_PARTY_LICENSES.txt'];
  }
  if (component.name === '@ffmpeg/core') {
    return [
      'node_modules/@bendyline/squisq-video-react/NOTICE.md',
      'node_modules/@bendyline/squisq-video-react/COPYING.GPL-2.0.txt',
      'node_modules/@bendyline/squisq-video-react/THIRD_PARTY_LICENSES.txt',
    ];
  }
  if (component.name === '@ironcalc/wasm') {
    return ['scripts/licenses/ironcalc/LICENSE-MIT.txt'];
  }
  if (component.name.startsWith('@ffmpeg/')) {
    return ['node_modules/@bendyline/squisq-video-react/THIRD_PARTY_LICENSES.txt'];
  }
  if (component.name.startsWith('@napi-rs/canvas-')) {
    return ['node_modules/@napi-rs/canvas/LICENSE'];
  }
  const readmeFallbacks: Readonly<Record<string, string>> = {
    format: 'node_modules/format/Readme.md',
    isarray: 'node_modules/isarray/README.md',
    'remark-math': 'node_modules/remark-math/readme.md',
  };
  const fallback = readmeFallbacks[component.name];
  return fallback ? [fallback] : [];
}

function addLicenseMaterial(
  materials: Map<string, LicenseMaterial>,
  component: Component,
  absolutePath: string,
): void {
  if (!existsSync(absolutePath)) {
    throw new Error(`License material for ${component.name} is missing: ${absolutePath}`);
  }
  const content = readdirSafeFile(absolutePath).trimEnd();
  const hash = createHash('sha256').update(content).digest('hex');
  const existing = materials.get(hash) ?? {
    content,
    packages: new Set<string>(),
    sources: new Set<string>(),
  };
  existing.packages.add(`${component.name}@${component.version}`);
  existing.sources.add(path.relative(repoRoot, absolutePath).replaceAll('\\', '/'));
  materials.set(hash, existing);
}

function collectLicenseMaterials(components: readonly Component[]): LicenseMaterialCollection {
  const materials = new Map<string, LicenseMaterial>();
  const missing: Component[] = [];
  for (const component of components) {
    const packageFiles = packageLicenseFiles(component);
    const files =
      packageFiles.length > 0
        ? packageFiles
        : fallbackLicenseFiles(component).map((file) => path.join(repoRoot, file));
    if (files.length === 0) {
      missing.push(component);
      continue;
    }
    for (const file of files) addLicenseMaterial(materials, component, file);
  }
  return {
    materials: [...materials.values()].sort((left, right) =>
      [...left.sources].sort()[0].localeCompare([...right.sources].sort()[0]),
    ),
    missing,
  };
}

function tableEscape(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function surfaceAssetNotes(surface: Surface): readonly string[] {
  if (surface.id === 'site') {
    return [
      'Font license texts are shipped beside the font assets in `fonts/licenses/`.',
      'The copied @ffmpeg/core WebAssembly distribution ships its GPL text, source pointers, and upstream notices in `ffmpeg-core/`.',
      'The copied IronCalc formula engine ships its selected upstream MIT license in `ironcalc/`.',
      'This notice and `THIRD_PARTY_COMPONENTS.json` are included in the PWA precache.',
    ];
  }
  if (surface.id === 'desktop') {
    return [
      'The copied @ffmpeg/core WebAssembly distribution ships its GPL text, source pointers, and upstream notices inside the renderer at `ffmpeg-core/`.',
      'The copied IronCalc formula engine and its selected upstream MIT license ship inside the renderer at `ironcalc/`.',
      "Electron's own license and Chromium third-party notices are copied as `licenses/ELECTRON_LICENSE.txt` and `licenses/ELECTRON_THIRD_PARTY_NOTICES.html` in the application resources directory.",
    ];
  }
  if (surface.id === 'vscode') {
    return [
      'This notice and the emitted `dist/webview/THIRD_PARTY_COMPONENTS.json` are included in the VSIX.',
      'The IronCalc formula engine and its selected upstream MIT license are included under `dist/webview/ironcalc/`.',
    ];
  }
  return [
    'This notice is included in the published npm tarball. Transitive packages installed by npm also retain their package-local license files.',
  ];
}

function renderSurfaceNotice(surface: Surface, components: readonly Component[]): string {
  const { materials, missing } = collectLicenseMaterials(components);
  const lines = [
    'GENERATED FILE - DO NOT EDIT',
    'Run `npm run generate:notices` from the repository root.',
    '',
    `# Third-Party Notices: ${surface.title}`,
    '',
    surface.description,
    '',
    `Inventory source: package-lock.json${surface.artifactManifest ? ` and ${surface.artifactManifest}` : ''}.`,
    `Components: ${components.length}.`,
    '',
    ...surfaceAssetNotes(surface),
    '',
    '## Component manifest',
    '',
    '| Package | Version | License | Source |',
    '| --- | --- | --- | --- |',
    ...components.map(
      (component) =>
        `| ${tableEscape(component.name)} | ${tableEscape(component.version)} | ${tableEscape(component.license)} | ${tableEscape(component.repository)} |`,
    ),
    '',
    '## License and notice texts',
    '',
    'Package-local license, copying, and notice files are reproduced below. Where a published package omits its repository license, the reviewed aggregate or README identified in `Source files` supplies the retained material.',
    '',
  ];

  if (missing.length > 0) {
    lines.push(
      '### Packages whose npm archive omits license text',
      '',
      'The following locked packages declare a license identifier but publish no package-local license/copying/notice file. Their identifiers and source locations are retained here for distribution review:',
      '',
      '| Package | Version | Declared license | Source |',
      '| --- | --- | --- | --- |',
      ...missing.map(
        (component) =>
          `| ${tableEscape(component.name)} | ${tableEscape(component.version)} | ${tableEscape(component.license)} | ${tableEscape(component.repository)} |`,
      ),
      '',
    );
  }

  for (const material of materials) {
    lines.push(
      '==============================================================================',
      `Components: ${[...material.packages].sort().join(', ')}`,
      `Source files: ${[...material.sources].sort().join(', ')}`,
      '==============================================================================',
      material.content,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function lockedVersion(packageName: string): string {
  const lockKey = rootLockKey(packageName);
  const version = lockPackages[lockKey]?.version;
  if (!version) throw new Error(`${packageName} has no locked version.`);
  return version;
}

function renderRootNotice(
  generatedSurfaces: readonly { surface: Surface; components: readonly Component[] }[],
): string {
  const fontLicenseRoot = path.join(repoRoot, 'packages/site/public/fonts/licenses');
  const fontLicenseCount = readdirSync(fontLicenseRoot).filter((file) =>
    licenseFilePattern.test(file),
  ).length;
  const squisqComponents = generatedSurfaces
    .flatMap(({ components }) => components)
    .filter((component) => component.name.startsWith('@bendyline/squisq'))
    .map((component) => `${component.name}@${component.version}`);
  const uniqueSquisq = [...new Set(squisqComponents)].sort();
  const missingMaterial = new Map<string, { component: Component; surfaces: Set<string> }>();
  for (const { surface, components } of generatedSurfaces) {
    for (const component of collectLicenseMaterials(components).missing) {
      const identity = `${component.name}@${component.version}`;
      const item = missingMaterial.get(identity) ?? { component, surfaces: new Set<string>() };
      item.surfaces.add(surface.title);
      missingMaterial.set(identity, item);
    }
  }

  return `${[
    '<!-- GENERATED FILE - run npm run generate:notices -->',
    '# Third-Party Notices',
    '',
    'This file is the distribution-level entry point for third-party software used by DocBlocks. The generated per-surface notices below are authoritative for their artifacts; they are derived from `package-lock.json`, workspace manifests, and the actual Vite/Rollup output graphs. This inventory is provided for engineering and review purposes and is not legal advice.',
    '',
    '## Distribution notices',
    '',
    '| Distribution | Notice shipped with the artifact | Inventory basis |',
    '| --- | --- | --- |',
    ...generatedSurfaces.map(
      ({ surface, components }) =>
        `| ${surface.title} | [${surface.output}](${surface.output}) | ${components.length} locked components |`,
    ),
    '',
    "The public npm package notices are explicitly included by each package's `files` allowlist. The VSIX content check requires its notice. The site precaches its notice and component manifest. Electron Builder copies the desktop notice, Electron license, and Chromium notices into every desktop distribution, and the packaged-desktop smoke test verifies them.",
    '',
    '## Material non-JavaScript distributions',
    '',
    `- The site ships ${fontLicenseCount} font-family license files from [packages/site/public/fonts/licenses](packages/site/public/fonts/licenses). The font binaries and their license files are copied together.`,
    `- Site and desktop renderer builds ship @ffmpeg/core@${lockedVersion('@ffmpeg/core')} (` +
      'GPL-2.0-or-later) as `ffmpeg-core.js` and `ffmpeg-core.wasm`. The same directory contains `COPYING.GPL-2.0.txt`, upstream notices, third-party licenses, and exact source-release pointers.',
    `- Site, desktop renderer, and VS Code webview builds ship @ironcalc/wasm@${lockedVersion('@ironcalc/wasm')} as a deferred formula engine, together with the selected upstream MIT license.`,
    `- Desktop distributions embed Electron ${lockedVersion('electron')}. Electron's MIT license and its Chromium third-party notice are copied from the pinned Electron distribution into the application resources directory.`,
    '',
    '## Major runtime components',
    '',
    `- Squisq packages: ${uniqueSquisq.join(', ')}.`,
    `- MCP SDK: @modelcontextprotocol/sdk@${lockedVersion('@modelcontextprotocol/sdk')}.`,
    `- Monaco Editor: monaco-editor@${lockedVersion('monaco-editor')}.`,
    `- Archive and PDF tooling: jszip@${lockedVersion('jszip')}, pdf-lib@${lockedVersion('pdf-lib')}, pdfjs-dist@${lockedVersion('pdfjs-dist')}, and @pdf-lib/upng@${lockedVersion('@pdf-lib/upng')}.`,
    '',
    '## Distribution review flags',
    '',
    ...(missingMaterial.size > 0
      ? [
          'The following upstream npm archives declare a license identifier but omit a package-local license/copying/notice file:',
          '',
          ...[...missingMaterial.values()]
            .sort((left, right) => left.component.name.localeCompare(right.component.name))
            .map(
              ({ component, surfaces: affectedSurfaces }) =>
                `- ${component.name}@${component.version} (${component.license}); affected artifact: ${[...affectedSurfaces].sort().join(', ')}; source: ${component.repository}.`,
            ),
          '',
        ]
      : [
          'All locked components in the generated surface inventories supplied package-local or reviewed fallback license material.',
          '',
        ]),
    '## Development-only repository inputs',
    '',
    `The root workspace pins Mocha ${lockedVersion('mocha')} and Vite ${lockedVersion('vite')} for testing and building. It also pins ffmpeg-static ${lockedVersion('ffmpeg-static')} (GPL-3.0-or-later) as a local development/test fallback. These root development dependencies are not included by the generated DocBlocks distribution manifests; shipped browser GIF encoding instead uses the separately noticed @ffmpeg/core WebAssembly distribution.`,
    '',
    '## Regeneration and drift checking',
    '',
    'Run `npm run generate:notices` after dependency or bundle changes. `npm run check:notices` regenerates the expected content in memory and fails on drift; the canonical `npm run all` release gate runs it automatically. Artifact-specific checks additionally verify that the generated notices are present in npm tarballs, the VSIX, the site/PWA, and packaged desktop resources.',
  ]
    .join('\n')
    .trimEnd()}\n`;
}

async function expectedOutputs(): Promise<ReadonlyMap<string, string>> {
  const outputs = new Map<string, string>();
  const generated: { surface: Surface; components: readonly Component[] }[] = [];
  for (const surface of surfaces) {
    const components = await componentsForSurface(surface);
    generated.push({ surface, components });
    outputs.set(surface.output, renderSurfaceNotice(surface, components));
  }
  outputs.set(
    'NOTICE.md',
    await formatWithPrettier(renderRootNotice(generated), { parser: 'markdown' }),
  );
  return outputs;
}

async function main(): Promise<void> {
  const outputs = await expectedOutputs();
  if (process.argv.includes('--write')) {
    for (const [relativePath, content] of outputs) {
      const absolutePath = path.join(repoRoot, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    }
    process.stdout.write(`Generated ${outputs.size} third-party notice files.\n`);
    return;
  }

  const stale: string[] = [];
  for (const [relativePath, expected] of outputs) {
    const absolutePath = path.join(repoRoot, relativePath);
    const actual = existsSync(absolutePath) ? await readFile(absolutePath, 'utf8') : null;
    if (actual !== expected) stale.push(relativePath);
  }
  if (stale.length > 0) {
    process.stderr.write(
      `Third-party notices are stale or missing:\n  ${stale.join('\n  ')}\nRun npm run generate:notices.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Third-party notices are fresh across ${surfaces.length} artifact surfaces.\n`,
  );
}

await main();
