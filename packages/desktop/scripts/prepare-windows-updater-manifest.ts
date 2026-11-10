/**
 * Write the Windows update feeds from electron-builder's latest.yml.
 *
 * electron-builder lists the x64, arm64, and combined NSIS installers in one
 * latest.yml. This checks each installer against its entry, writes a manifest
 * per architecture beside it, and rewrites latest.yml to name only the
 * combined installer. main/updater-feed.ts explains which client reads which.
 */

import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { WINDOWS_FEED_ARCHITECTURES, windowsFeedChannel } from '../main/updater-feed.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

interface UpdaterFile extends UnknownRecord {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
  readonly blockMapSize?: number;
}

export interface WindowsUpdateFeed {
  /** The manifest's file name; it is written beside the installers. */
  readonly manifest: string;
  /** The one installer the manifest names. */
  readonly installer: string;
}

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

function requireOneInstaller(
  files: readonly UpdaterFile[],
  suffix: string,
  description: string,
): UpdaterFile {
  const matches = files.filter((file) => file.url.toLowerCase().endsWith(suffix));
  const [match] = matches;
  if (matches.length !== 1 || !match) {
    throw new Error(
      'Windows updater manifest must contain exactly one ' +
        description +
        ' installer; found ' +
        matches.length +
        '.',
    );
  }
  return match;
}

async function statRequired(filePath: string, description: string): Promise<Stats> {
  try {
    return await stat(filePath);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new Error(description + ' is missing.');
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

/** Fail before publishing an entry that the installer or blockmap on disk does not match. */
async function verifyInstaller(directory: string, file: UpdaterFile): Promise<void> {
  const installerPath = path.join(directory, file.url);
  const installerStat = await statRequired(installerPath, file.url);
  if (!installerStat.isFile() || installerStat.size !== file.size) {
    throw new Error(
      file.url + ' size mismatch: manifest=' + file.size + ', artifact=' + installerStat.size + '.',
    );
  }

  const blockMapStat = await statRequired(installerPath + '.blockmap', file.url + ' blockmap');
  if (!blockMapStat.isFile() || blockMapStat.size < 1) {
    throw new Error(file.url + ' blockmap must be a non-empty file.');
  }
  if (file.blockMapSize !== undefined && blockMapStat.size !== file.blockMapSize) {
    throw new Error(
      file.url +
        ' blockmap size mismatch: manifest=' +
        file.blockMapSize +
        ', artifact=' +
        blockMapStat.size +
        '.',
    );
  }

  if ((await sha512Base64(installerPath)) !== file.sha512) {
    throw new Error(file.url + ' SHA-512 does not match latest.yml.');
  }
}

function feedManifest(parsed: UnknownRecord, file: UpdaterFile): string {
  const manifest: UnknownRecord = {
    ...parsed,
    files: [file],
    path: file.url,
    sha512: file.sha512,
  };
  return yaml.dump(manifest, { lineWidth: -1, noRefs: true, sortKeys: false });
}

export async function prepareWindowsUpdaterManifest(
  manifestPath: string,
): Promise<readonly WindowsUpdateFeed[]> {
  const combinedManifestPath = path.resolve(manifestPath);
  const parsed: unknown = yaml.load(await readFile(combinedManifestPath, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    throw new Error('Windows updater manifest must contain a files array.');
  }

  const files = parsed.files.map(requireUpdaterFile);
  const directory = path.dirname(combinedManifestPath);
  // The combined feed goes last: it replaces the manifest this script reads,
  // so everything else is verified and written while that input is intact.
  const feeds = [
    ...WINDOWS_FEED_ARCHITECTURES.map((architecture) => ({
      manifestPath: path.join(directory, windowsFeedChannel(architecture) + '.yml'),
      file: requireOneInstaller(
        files,
        '-win-' + architecture + '.exe',
        '*-win-' + architecture + '.exe',
      ),
    })),
    {
      manifestPath: combinedManifestPath,
      file: requireOneInstaller(files, '-win.exe', 'combined *-win.exe'),
    },
  ];

  for (const feed of feeds) await verifyInstaller(directory, feed.file);
  for (const feed of feeds) {
    await writeFile(feed.manifestPath, feedManifest(parsed, feed.file), 'utf8');
  }
  return feeds.map((feed) => ({
    manifest: path.basename(feed.manifestPath),
    installer: feed.file.url,
  }));
}

async function runCli(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath || process.argv.length !== 3) {
    throw new Error('Usage: prepare-windows-updater-manifest <latest.yml>');
  }
  for (const feed of await prepareWindowsUpdaterManifest(manifestPath)) {
    process.stdout.write(feed.manifest + ' names ' + feed.installer + '.\n');
  }
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
  void runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  });
}
