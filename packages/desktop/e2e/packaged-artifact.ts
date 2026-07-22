import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARTIFACTS_DIR = path.resolve(__dirname, '..', 'dist', 'artifacts');
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');

export const FUSE_STATE = {
  disabled: 48,
  enabled: 49,
} as const;

export interface PackagedArtifact {
  executablePath: string;
  appAsarPath: string;
  fuseBinaryPath: string;
  resourcesPath: string;
}

export interface FuseWire {
  version: number;
  states: readonly number[];
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function normalizeExecutableOverride(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (process.platform === 'darwin' && resolved.endsWith('.app')) {
    return path.join(resolved, 'Contents', 'MacOS', 'DocBlocks');
  }
  return resolved;
}

function unpackedDirectories(artifactsDir: string, prefix: string): string[] {
  if (!fs.existsSync(artifactsDir)) return [];
  return fs
    .readdirSync(artifactsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(artifactsDir, entry.name));
}

function unpackedDirectoryRank(
  directory: string,
  platform: NodeJS.Platform,
  architecture: string,
): number | null {
  const name = path.basename(directory);

  if (platform === 'darwin' && name.includes('universal')) return 1;
  if (architecture === 'x64') {
    const unsuffixedName = platform === 'win32' ? 'win-unpacked' : `${platform}-unpacked`;
    const nativeUnsuffixedName = platform === 'darwin' ? 'mac' : unsuffixedName;
    return name === nativeUnsuffixedName || name.includes('x64') ? 0 : null;
  }
  return name.includes(`-${architecture}`) ? 0 : null;
}

function compatibleUnpackedDirectories(
  artifactsDir: string,
  prefix: string,
  platform: NodeJS.Platform,
  architecture: string,
): string[] {
  return unpackedDirectories(artifactsDir, prefix)
    .map((directory) => ({
      directory,
      rank: unpackedDirectoryRank(directory, platform, architecture),
    }))
    .filter((entry): entry is { directory: string; rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.directory.localeCompare(right.directory))
    .map((entry) => entry.directory);
}

export function candidateExecutables(
  artifactsDir: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string[] {
  if (platform === 'win32') {
    return compatibleUnpackedDirectories(artifactsDir, 'win-', platform, architecture).map(
      (directory) => path.join(directory, 'DocBlocks.exe'),
    );
  }

  if (platform === 'darwin') {
    return compatibleUnpackedDirectories(artifactsDir, 'mac', platform, architecture).map(
      (directory) => path.join(directory, 'DocBlocks.app', 'Contents', 'MacOS', 'DocBlocks'),
    );
  }

  const names = ['docblocks-desktop', 'docblocks', 'DocBlocks'];
  return compatibleUnpackedDirectories(artifactsDir, 'linux-', platform, architecture).flatMap(
    (directory) => names.map((name) => path.join(directory, name)),
  );
}

function appAsarForExecutable(executablePath: string): string {
  if (process.platform === 'darwin') {
    return path.resolve(path.dirname(executablePath), '..', 'Resources', 'app.asar');
  }
  return path.join(path.dirname(executablePath), 'resources', 'app.asar');
}

function fuseBinaryForExecutable(executablePath: string): string {
  if (process.platform === 'darwin') {
    return path.resolve(
      path.dirname(executablePath),
      '..',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework',
    );
  }
  return executablePath;
}

/**
 * Resolve an electron-builder `--dir` output for the current host platform.
 * An explicit executable allows CI to smoke-test a previously uploaded or
 * downloaded artifact instead of rebuilding it in place.
 */
export function resolvePackagedArtifact(): PackagedArtifact {
  const override = process.env.DOCBLOCKS_PACKAGED_EXECUTABLE;
  const artifactsDir = path.resolve(process.env.DOCBLOCKS_PACKAGED_DIR ?? DEFAULT_ARTIFACTS_DIR);
  const candidates = override
    ? [normalizeExecutableOverride(override)]
    : candidateExecutables(artifactsDir);
  const executable = candidates.find(isFile);

  if (!executable) {
    const searched = candidates.length > 0 ? candidates.join(', ') : artifactsDir;
    throw new Error(
      `No unpacked DocBlocks application was found for ${process.platform}/${process.arch}. ` +
        `Searched: ${searched}. Run "npm run dist:dir -w docblocks-desktop" first, or set ` +
        'DOCBLOCKS_PACKAGED_EXECUTABLE to the packaged application executable.',
    );
  }

  const executablePath = fs.realpathSync(executable);
  const appAsar = appAsarForExecutable(executablePath);
  const fuseBinary = fuseBinaryForExecutable(executablePath);
  if (!isFile(appAsar)) {
    throw new Error(
      `The resolved executable is not an electron-builder packaged artifact: missing ${appAsar}`,
    );
  }
  if (!isFile(fuseBinary)) {
    throw new Error(`The packaged Electron fuse binary is missing: ${fuseBinary}`);
  }

  return {
    executablePath,
    appAsarPath: fs.realpathSync(appAsar),
    fuseBinaryPath: fs.realpathSync(fuseBinary),
    resourcesPath: fs.realpathSync(path.dirname(appAsar)),
  };
}

/** Read every architecture slice's Electron fuse wire from the shipped binary. */
export function readFuseWires(binaryPath: string): readonly FuseWire[] {
  const binary = fs.readFileSync(binaryPath);
  const wires: FuseWire[] = [];
  let cursor = 0;

  while (cursor < binary.length) {
    const sentinelIndex = binary.indexOf(FUSE_SENTINEL, cursor);
    if (sentinelIndex < 0) break;
    const wireStart = sentinelIndex + FUSE_SENTINEL.length;
    if (wireStart + 2 > binary.length) {
      throw new Error(`Truncated Electron fuse header in ${binaryPath}`);
    }
    const version = binary[wireStart];
    const length = binary[wireStart + 1];
    if (
      length === undefined ||
      length < 1 ||
      length > 64 ||
      wireStart + 2 + length > binary.length
    ) {
      throw new Error(`Invalid Electron fuse wire in ${binaryPath}`);
    }
    wires.push({
      version: version ?? 0,
      states: [...binary.subarray(wireStart + 2, wireStart + 2 + length)],
    });
    cursor = wireStart + 2 + length;
  }

  if (wires.length === 0) {
    throw new Error(`Electron fuse sentinel was not found in ${binaryPath}`);
  }
  return wires;
}
