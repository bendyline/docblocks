/**
 * Keep Intel Macs pointed at their final DocBlocks release.
 *
 * electron-updater on an Intel Mac discards every arm64 file in latest-mac.yml
 * and fails when nothing is left, so an Apple-silicon-only feed leaves older
 * Intel installs reporting an update error on every launch. Release CI builds
 * one x64 update zip, for the version in intel-mac-final.json, and this script
 * adds it to that release's feed and to every later one. The final build never
 * checks for updates again (main/intel-mac-final.ts).
 *
 * Later feeds name the zip by a path into the final release: the GitHub
 * provider resolves file names under the newest release tag, and
 * `../desktop-v<final>/` normalizes back to the final release's download path.
 * The zip ships without a blockmap. For such an entry electron-updater derives
 * identical "old" and "new" blockmap URLs, so a published blockmap could let it
 * rebuild the zip from an unrelated cached update; without one it always
 * downloads the zip whole and checks its SHA-512.
 */

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
}

export interface IntelMacFinalPolicy {
  readonly version: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireUpdaterFile(value: unknown, label: string): UpdaterFile {
  if (
    !isRecord(value) ||
    typeof value.url !== 'string' ||
    typeof value.sha512 !== 'string' ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1
  ) {
    throw new Error(`${label} is malformed.`);
  }
  return value as UpdaterFile;
}

type MacFeed = UnknownRecord & {
  readonly version: string;
  readonly files: readonly UpdaterFile[];
};

function requireFeed(value: unknown, label: string): MacFeed {
  if (!isRecord(value) || typeof value.version !== 'string' || !Array.isArray(value.files)) {
    throw new Error(`${label} must contain a version and a files array.`);
  }
  return {
    ...value,
    version: value.version,
    files: value.files.map((file, index) => requireUpdaterFile(file, `${label} files[${index}]`)),
  };
}

/** electron-updater's own test: a file is for Apple silicon iff its URL says arm64. */
function isArm64File(file: UpdaterFile): boolean {
  return file.url.includes('arm64');
}

export function intelMacFinalFileName(policy: IntelMacFinalPolicy): string {
  return `DocBlocks-${policy.version}-mac-x64.zip`;
}

/** The feed URL for the final Intel zip, relative to the release being published. */
export function intelMacFinalUrl(policy: IntelMacFinalPolicy, feedVersion: string): string {
  const fileName = intelMacFinalFileName(policy);
  return feedVersion === policy.version ? fileName : `../desktop-v${policy.version}/${fileName}`;
}

/**
 * Return `feed` with the final Intel zip appended. `intelFeed` is the feed that
 * electron-builder wrote for that zip, or the final release's published feed.
 * Any other non-arm64 entry is rejected: Intel builds ended with the policy version.
 */
export function withIntelMacFinal(
  feedValue: unknown,
  intelFeedValue: unknown,
  policy: IntelMacFinalPolicy,
): MacFeed {
  const feed = requireFeed(feedValue, 'latest-mac.yml');
  const intelFeed = requireFeed(intelFeedValue, 'Final Intel Mac feed');
  if (intelFeed.version !== policy.version) {
    throw new Error(
      `Final Intel Mac feed is version ${intelFeed.version}; intel-mac-final.json says ${policy.version}.`,
    );
  }
  const fileName = intelMacFinalFileName(policy);
  const intelZip = intelFeed.files.find(
    (file) => file.url === fileName || file.url.endsWith(`/${fileName}`),
  );
  if (!intelZip) throw new Error(`Final Intel Mac feed does not list ${fileName}.`);

  const entry: UpdaterFile = {
    url: intelMacFinalUrl(policy, feed.version),
    sha512: intelZip.sha512,
    size: intelZip.size,
  };
  // Idempotent: a re-run finds the entry it added before.
  const files = feed.files.filter(
    (file) => !(file.url === entry.url && file.sha512 === entry.sha512 && file.size === entry.size),
  );
  const foreign = files.filter((file) => !isArm64File(file));
  if (foreign.length > 0) {
    throw new Error(
      `Intel Macs are no longer supported; latest-mac.yml may only add ${fileName}, ` +
        `not ${foreign.map((file) => file.url).join(', ')}.`,
    );
  }
  if (!files.some((file) => file.url.endsWith('.zip'))) {
    throw new Error('latest-mac.yml has no Apple silicon update zip.');
  }
  return { ...feed, files: [...files, entry] };
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** In the final release itself, prove the zip beside the feed is the one it names. */
async function verifyLocalIntelZip(
  artifactsDirectory: string,
  entry: UpdaterFile,
  fileName: string,
): Promise<void> {
  const zipPath = path.join(artifactsDirectory, fileName);
  const [info, sha512] = await Promise.all([stat(zipPath), sha512Base64(zipPath)]);
  if (!info.isFile() || info.size !== entry.size || sha512 !== entry.sha512) {
    throw new Error(`${fileName} does not match its feed entry.`);
  }
  if (await exists(zipPath + '.blockmap')) {
    throw new Error(`${fileName}.blockmap must not be published; see intel-mac-final-feed.ts.`);
  }
}

export async function addIntelMacFinalToFeed(
  feedPath: string,
  intelFeedPath: string,
  policy: IntelMacFinalPolicy,
): Promise<string> {
  const [feedValue, intelFeedValue] = await Promise.all([
    readFile(feedPath, 'utf8').then((text) => yaml.load(text)),
    readFile(intelFeedPath, 'utf8').then((text) => yaml.load(text)),
  ]);
  const merged = withIntelMacFinal(feedValue, intelFeedValue, policy);
  const entry = merged.files[merged.files.length - 1];
  if (!entry) throw new Error('latest-mac.yml lost its files.');
  if (merged.version === policy.version) {
    await verifyLocalIntelZip(path.dirname(feedPath), entry, intelMacFinalFileName(policy));
  }
  await writeFile(
    feedPath,
    yaml.dump(merged, { lineWidth: -1, noRefs: true, sortKeys: false }),
    'utf8',
  );
  return entry.url;
}

async function runCli(): Promise<void> {
  const [feedPath, intelFeedPath] = process.argv.slice(2);
  if (!feedPath || !intelFeedPath || process.argv.length !== 4) {
    throw new Error('Usage: intel-mac-final-feed <latest-mac.yml> <final Intel latest-mac.yml>');
  }
  const policyPath = fileURLToPath(new URL('../intel-mac-final.json', import.meta.url));
  const policy: unknown = JSON.parse(await readFile(policyPath, 'utf8'));
  if (!isRecord(policy) || typeof policy.version !== 'string') {
    throw new Error('intel-mac-final.json must name a version.');
  }
  const url = await addIntelMacFinalToFeed(path.resolve(feedPath), path.resolve(intelFeedPath), {
    version: policy.version,
  });
  process.stdout.write(`latest-mac.yml points Intel Macs at ${url}.\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
  void runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  });
}
