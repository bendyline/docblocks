/**
 * Stage the bundled embedding model (embedding-model.json) where packaging
 * copies it from: dist/embedding-model/<repo>/<revision>/<file>, the
 * transformers.js cache layout the embedder reads with `localFilesOnly`.
 *
 * Every file is checked against its pinned SHA-256. A copy already staged
 * is kept when it matches; otherwise the file comes from a local Hugging Face
 * cache that holds the same bytes (Gezel's, or GEZEL_HF_CACHE_DIR), and only
 * then from the Hub at the pinned revision. Nothing is downloaded at runtime.
 */
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { copyFile, mkdir, rename, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');
const MANIFEST = require('../embedding-model.json');

function stagedModelRoot(appDir = APP_DIR) {
  return path.join(appDir, 'dist', 'embedding-model');
}

function cachePath(root, manifest, file, { unversioned = file.unversioned === true } = {}) {
  const revision = unversioned ? [] : [manifest.revision];
  return path.join(root, ...manifest.repo.split('/'), ...revision, ...file.path.split('/'));
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function matches(file, pin) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size !== pin.bytes) return false;
    return (await sha256File(file)) === pin.sha256;
  } catch {
    return false;
  }
}

/** Local caches that may already hold the pinned files. */
function localCaches(env = process.env) {
  const roots = [
    env.GEZEL_HF_CACHE_DIR,
    path.join(env.GEZEL_HOME || path.join(os.homedir(), '.gezel'), 'engines', 'hf-cache'),
  ];
  return roots.filter((root) => typeof root === 'string' && root.trim() !== '');
}

async function download(url, destination, pin, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url} (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== pin.bytes) {
    throw new Error(`${pin.path} is ${bytes.length} bytes, not the pinned ${pin.bytes}.`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.sha256) throw new Error(`${pin.path} does not match its pinned digest.`);
  await writeFile(destination, bytes);
}

async function stageEmbeddingModel(
  { appDir = APP_DIR, manifest = MANIFEST, env = process.env } = {},
  overrides = {},
) {
  const root = stagedModelRoot(appDir);
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const caches = overrides.caches ?? localCaches(env);
  const sources = [];
  for (const pin of manifest.files) {
    const destination = cachePath(root, manifest, pin);
    if (await matches(destination, pin)) {
      sources.push(`${pin.path}: staged`);
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const partial = `${destination}.partial`;
    await rm(partial, { force: true });
    let found = null;
    // The same bytes, wherever a cache keeps them.
    const candidates = caches.flatMap((cache) => [
      cachePath(cache, manifest, pin, { unversioned: false }),
      cachePath(cache, manifest, pin, { unversioned: true }),
    ]);
    for (const candidate of candidates) {
      if (await matches(candidate, pin)) {
        found = candidate;
        break;
      }
    }
    if (found) {
      await copyFile(found, partial);
      if (!(await matches(partial, pin))) throw new Error(`${pin.path} changed while copying.`);
      sources.push(`${pin.path}: local cache`);
    } else {
      const url = `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${pin.path}`;
      await download(url, partial, pin, fetchImpl);
      sources.push(`${pin.path}: downloaded`);
    }
    await rename(partial, destination);
  }
  // The model's license travels with it.
  await copyFile(path.join(appDir, 'embedding-model.LICENSE.txt'), path.join(root, 'LICENSE'));
  return { root, sources };
}

/** Why the staged model is missing or wrong, or null. Reads files only. */
async function embeddingModelStagingProblem({ appDir = APP_DIR, manifest = MANIFEST } = {}) {
  const root = stagedModelRoot(appDir);
  for (const pin of manifest.files) {
    if (!(await matches(cachePath(root, manifest, pin), pin))) {
      return `The embedding model file ${pin.path} is not staged. Run \`npm run stage:embedding-model\`.`;
    }
  }
  return null;
}

if (require.main === module) {
  stageEmbeddingModel().then(
    ({ root, sources }) => {
      console.log(`Staged ${MANIFEST.profileId} in ${root}`);
      for (const line of sources) console.log(`  ${line}`);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}

exports.stageEmbeddingModel = stageEmbeddingModel;
exports.embeddingModelStagingProblem = embeddingModelStagingProblem;
exports.stagedModelRoot = stagedModelRoot;
