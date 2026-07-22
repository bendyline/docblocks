import fs from 'node:fs';
import path from 'node:path';
import type { OutputBundle, Plugin } from 'rollup';

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
}

interface ThirdPartyComponent {
  readonly name: string;
  readonly version: string;
}

const FIRST_PARTY_PACKAGES = new Set([
  'docblocks',
  'docblocks-desktop',
  'docblocks-site',
  'docblocks-vscode',
  '@bendyline/docblocks',
  '@bendyline/docblocks-cli',
  '@bendyline/docblocks-react',
]);

function readPackageManifest(directory: string): PackageManifest | null {
  const manifestPath = path.join(directory, 'package.json');
  if (!fs.existsSync(manifestPath)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as PackageManifest;
}

function componentForModule(
  rawModuleId: string,
  cache: Map<string, ThirdPartyComponent | null>,
): ThirdPartyComponent | null {
  if (rawModuleId.startsWith('\0')) return null;
  const moduleId = rawModuleId.replace(/[?#].*$/u, '');
  if (!path.isAbsolute(moduleId)) return null;

  let directory =
    fs.existsSync(moduleId) && fs.statSync(moduleId).isDirectory()
      ? moduleId
      : path.dirname(moduleId);
  const visited: string[] = [];
  while (true) {
    const cached = cache.get(directory);
    if (cached !== undefined) {
      for (const candidate of visited) cache.set(candidate, cached);
      return cached;
    }
    visited.push(directory);

    const manifest = readPackageManifest(directory);
    if (manifest?.name && manifest.version) {
      const component = FIRST_PARTY_PACKAGES.has(manifest.name)
        ? null
        : { name: manifest.name, version: manifest.version };
      for (const candidate of visited) cache.set(candidate, component);
      return component;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      for (const candidate of visited) cache.set(candidate, null);
      return null;
    }
    directory = parent;
  }
}

function collectComponents(bundle: OutputBundle): readonly ThirdPartyComponent[] {
  const cache = new Map<string, ThirdPartyComponent | null>();
  const byIdentity = new Map<string, ThirdPartyComponent>();
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue;
    for (const moduleId of Object.keys(output.modules)) {
      const component = componentForModule(moduleId, cache);
      if (component) byIdentity.set(`${component.name}@${component.version}`, component);
    }
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

/** Emit the exact third-party package identities present in Vite's output graph. */
export function thirdPartyComponentManifestPlugin(): Plugin {
  return {
    name: 'docblocks-third-party-component-manifest',
    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_COMPONENTS.json',
        source: `${JSON.stringify(
          {
            schemaVersion: 1,
            generatedFrom: 'Vite/Rollup output module graph',
            components: collectComponents(bundle),
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}
