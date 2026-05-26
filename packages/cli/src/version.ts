import { readFileSync } from 'node:fs';

interface PackageJson {
  version?: unknown;
}

export function getPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const pkg = JSON.parse(raw) as PackageJson;
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to a conservative fallback for unusual bundled layouts.
  }

  return '0.0.0';
}
