/** Restrict Windows auto-update metadata to the combined NSIS installer. */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type UnknownRecord = Readonly<Record<string, unknown>>;

interface UpdaterFile extends UnknownRecord {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
  readonly blockMapSize?: number;
}

const UNIVERSAL_INSTALLER_PATTERN = /-win\.exe$/iu;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireUpdaterFile(value: unknown, index: number): UpdaterFile {
  if (
    !isRecord(value) ||
    typeof value.url !== 'string' ||
    typeof value.sha512 !== 'string' ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    (value.blockMapSize !== undefined &&
      (typeof value.blockMapSize !== 'number' ||
        !Number.isSafeInteger(value.blockMapSize) ||
        value.blockMapSize < 1))
  ) {
    throw new Error('Windows updater manifest files[' + index + '] is malformed.');
  }
  if (/[\\/]/u.test(value.url) || path.basename(value.url) !== value.url) {
    throw new Error('Windows updater manifest files[' + index + '] must name one local artifact.');
  }
  return value as UpdaterFile;
}

async function statRequiredBlockMap(
  blockMapPath: string,
): Promise<Awaited<ReturnType<typeof stat>>> {
  try {
    return await stat(blockMapPath);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new Error('Combined Windows installer blockmap is missing.');
    }
    throw error;
  }
}

async function sha512Base64(filePath: string): Promise<string> {
  const hash = createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on('data', (chunk: Buffer) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('base64');
}

export async function prepareWindowsUpdaterManifest(manifestPath: string): Promise<string> {
  const parsed: unknown = yaml.load(await readFile(manifestPath, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    throw new Error('Windows updater manifest must contain a files array.');
  }

  const files = parsed.files.map(requireUpdaterFile);
  const universalInstallers = files.filter((file) => UNIVERSAL_INSTALLER_PATTERN.test(file.url));
  if (universalInstallers.length !== 1) {
    throw new Error(
      'Windows updater manifest must contain exactly one combined *-win.exe installer; found ' +
        universalInstallers.length +
        '.',
    );
  }

  const universal = universalInstallers[0];
  if (!universal) {
    throw new Error('Combined Windows installer metadata is missing.');
  }
  const artifactsDirectory = path.dirname(path.resolve(manifestPath));
  const installerPath = path.join(artifactsDirectory, universal.url);
  const blockMapPath = installerPath + '.blockmap';
  const [installerStat, blockMapStat, actualSha512] = await Promise.all([
    stat(installerPath),
    statRequiredBlockMap(blockMapPath),
    sha512Base64(installerPath),
  ]);

  if (!installerStat.isFile() || installerStat.size !== universal.size) {
    throw new Error(
      'Combined Windows installer size mismatch: manifest=' +
        universal.size +
        ', artifact=' +
        installerStat.size +
        '.',
    );
  }
  if (!blockMapStat.isFile() || blockMapStat.size < 1) {
    throw new Error('Combined Windows installer blockmap must be a non-empty file.');
  }
  if (universal.blockMapSize !== undefined && blockMapStat.size !== universal.blockMapSize) {
    throw new Error(
      'Combined Windows installer blockmap size mismatch: manifest=' +
        universal.blockMapSize +
        ', artifact=' +
        blockMapStat.size +
        '.',
    );
  }
  if (actualSha512 !== universal.sha512) {
    throw new Error('Combined Windows installer SHA-512 does not match latest.yml.');
  }

  const normalized: UnknownRecord = {
    ...parsed,
    files: [universal],
    path: universal.url,
    sha512: universal.sha512,
  };
  await writeFile(
    manifestPath,
    yaml.dump(normalized, { lineWidth: -1, noRefs: true, sortKeys: false }),
    'utf8',
  );
  return universal.url;
}

async function runCli(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath || process.argv.length !== 3) {
    throw new Error('Usage: prepare-windows-updater-manifest <latest.yml>');
  }
  const installer = await prepareWindowsUpdaterManifest(path.resolve(manifestPath));
  process.stdout.write('Windows updater manifest selects only ' + installer + '.\n');
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
  void runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  });
}
