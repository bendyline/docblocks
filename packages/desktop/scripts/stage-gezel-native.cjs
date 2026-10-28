/** electron-builder adapter. Gezel owns archive pins, extraction, and verification. */
const { readFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const path = require('node:path');
const { stageVcRuntime } = require('./stage-vc-runtime.cjs');
const { verifyNativePlatformRequirements } = require('./native-platform-requirements.cjs');
const intelMacFinal = require('../intel-mac-final.json');

const APP_DIR = path.join(__dirname, '..');
/** electron-builder's `${os}` for a source build's own platform. */
const BUILDER_OS = { win32: 'win', darwin: 'mac', linux: 'linux' };

function stagedDirectory(appDir, os, arch) {
  return path.join(appDir, 'dist', 'gezel-native', `${os}-${arch}`);
}

/** Stage one platform's engines where packaging copies them from. */
async function stageGezelNative({ appDir, platform, arch, os }, overrides = {}) {
  const serviceRequire = createRequire(require.resolve('@bendyline/gezel-inference/package.json'));
  const manifest = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
  const installed = serviceRequire('./package.json');
  if (manifest.dependencies['@bendyline/gezel-inference'] !== installed.version) {
    throw new Error(
      "The installed Gezel inference runtime must match DocBlocks' exact dependency pin.",
    );
  }
  // Intel Macs stopped at intel-mac-final.json's version, which has shipped.
  // Later releases only point Intel Macs back at it, so nothing builds darwin-x64.
  if (platform === 'darwin' && arch === 'x64') {
    throw new Error(
      `Intel Macs are no longer supported; DocBlocks ${intelMacFinal.version} was their final release.`,
    );
  }
  const stage =
    overrides.stageElectronNative ??
    require('@bendyline/gezel-inference/packaging').stageElectronNative;
  const destination = stagedDirectory(appDir, os, arch);
  await stage({
    platform,
    arch,
    destination,
    cache: path.join(appDir, 'dist', 'gezel-native-cache'),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  await (overrides.verifyNativePlatformRequirements ?? verifyNativePlatformRequirements)({
    directory: destination,
    platform,
  });
  return destination;
}

async function stageForTarget(context, overrides = {}) {
  const appDir = context.packager.info.appDir;
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName;
  const arch = require('builder-util').Arch[context.arch];
  await stageGezelNative(
    { appDir, platform, arch, os: context.packager.platform?.buildConfigurationKey },
    overrides,
  );
  if (platform === 'win32') {
    // This also serves DocBlocks' speech runtime, which is outside the text AI host.
    await stageVcRuntime({
      arch,
      destination: path.join(appDir, 'dist', 'vc-runtime', arch),
      ...(overrides.vcRuntime ?? {}),
    });
  }
}

/**
 * `npm run stage:gezel-native`: this machine's engines for a source build,
 * which runs them exactly as a packaged build runs its bundled copy.
 */
async function stageForSourceBuild(
  { appDir = APP_DIR, platform = process.platform, arch = process.arch } = {},
  overrides = {},
) {
  const os = BUILDER_OS[platform];
  if (!os) throw new Error(`DocBlocks has no Gezel engines for ${platform}.`);
  return stageGezelNative({ appDir, platform, arch, os }, overrides);
}

/**
 * Why a source build cannot run its staged engines, or null when it can.
 * Reads files only: staging is always the explicit `stage:gezel-native`.
 */
async function sourceBuildStagingProblem({
  appDir = APP_DIR,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  release,
} = {}) {
  const os = BUILDER_OS[platform];
  if (!os || env.DOCBLOCKS_GEZEL_NATIVE_BIN_DIR?.trim()) return null;
  const pinned =
    release ?? (await import('@bendyline/gezel-inference/native-release')).NATIVE_ENGINE_RELEASE;
  let staged = null;
  try {
    const file = path.join(stagedDirectory(appDir, os, arch), 'release.json');
    staged = JSON.parse(await readFile(file, 'utf8')).release ?? null;
  } catch {
    // Not staged yet.
  }
  if (staged === pinned) return null;
  return staged
    ? `The staged Gezel engines are release ${staged}, but this build pins ${pinned}.`
    : `No Gezel engines are staged for release ${pinned}.`;
}

if (require.main === module) {
  stageForSourceBuild().then(
    (destination) => console.log(`Staged Gezel engines in ${destination}`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}

exports.default = (context) => stageForTarget(context);
exports.stageForTarget = stageForTarget;
exports.stageForSourceBuild = stageForSourceBuild;
exports.sourceBuildStagingProblem = sourceBuildStagingProblem;
