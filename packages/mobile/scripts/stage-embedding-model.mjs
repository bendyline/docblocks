/**
 * Bundle the semantic-search model into a native app: the pinned files of
 * Gezel's `bge-small-en-v1.5@1` query model in the app's
 * `public/embedding-model/`, with a manifest naming Gezel's store folder and
 * each file's digest. At launch the app copies them into Gezel's knowledge
 * store and records them as installed (AppDelegate.swift on iOS,
 * BundledEmbeddingModel.java on Android), so search by meaning and the
 * knowledge catalogs' questions work offline from the first launch.
 *
 * Runs after `cap sync`, which replaces the public folder:
 *
 *   node scripts/stage-embedding-model.mjs ios|android
 *
 * The files come from the desktop's staged copy (its stager takes them from a
 * local Hugging Face cache or the Hub at the pinned revision, digest-checked).
 * The desktop pins must equal the Capacitor SDK's query model for the
 * profile, so both apps embed with exactly one model.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { mobileQueryModels, queryModelStoreId } from '@bendyline/gezel-capacitor';

const mobile = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(mobile, '../desktop');
const require = createRequire(import.meta.url);
const pins = require(path.join(desktop, 'embedding-model.json'));
const { stageEmbeddingModel } = require(path.join(desktop, 'scripts/stage-embedding-model.cjs'));

const TARGETS = {
  ios: 'ios/App/App/public/embedding-model',
  android: 'android/app/src/main/assets/public/embedding-model',
};

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** The SDK's files for the desktop's profile, checked against the desktop's pins. */
function queryModelFiles() {
  const model = mobileQueryModels.find((candidate) => candidate.id === pins.profileId);
  if (!model) throw new Error(`The Capacitor SDK has no query model for ${pins.profileId}.`);
  for (const file of model.files) {
    const pin = pins.files.find((entry) => entry.path === file.name && !entry.unversioned);
    if (!pin || pin.sha256 !== file.sha256 || pin.bytes !== file.size) {
      throw new Error(`${file.name}: the desktop's pin differs from the SDK's query model.`);
    }
  }
  return model.files;
}

export async function stageMobileEmbeddingModel(platform) {
  const relative = TARGETS[platform];
  if (!relative) throw new Error('Name a platform: ios or android.');
  const publicDir = path.dirname(path.join(mobile, relative));
  try {
    await fs.access(publicDir);
  } catch {
    throw new Error(
      `${path.relative(mobile, publicDir)} is missing; run \`cap sync ${platform}\` first.`,
    );
  }
  const files = queryModelFiles();
  const { root } = await stageEmbeddingModel({ appDir: desktop });
  const source = path.join(root, ...pins.repo.split('/'), pins.revision);
  const target = path.join(mobile, relative);
  await fs.rm(target, { recursive: true, force: true });
  for (const file of files) {
    const from = path.join(source, ...file.name.split('/'));
    const to = path.join(target, ...file.name.split('/'));
    await fs.mkdir(path.dirname(to), { recursive: true });
    // A clone where the filesystem allows it: staging 127 MB twice costs nothing on APFS.
    await fs.copyFile(from, to, fs.constants.COPYFILE_FICLONE);
    if ((await sha256(to)) !== file.sha256) throw new Error(`${file.name} changed while copying.`);
  }
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(target, 'LICENSE'));
  const manifest = {
    profileId: pins.profileId,
    store: queryModelStoreId(pins.profileId),
    files: files.map(({ name, sha256: digest, size }) => ({ name, sha256: digest, size })),
  };
  await fs.writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { target, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  stageMobileEmbeddingModel(process.argv[2]).then(
    ({ target, manifest }) => {
      process.stdout.write(
        `Bundled ${manifest.profileId} (${manifest.files.length} files) in ${path.relative(mobile, target)}\n`,
      );
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
