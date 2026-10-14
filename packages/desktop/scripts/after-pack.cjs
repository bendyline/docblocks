const path = require('node:path');
const { default: prepareMasGezel } = require('./prepare-mas-gezel.cjs');
const { verifyNativePlatformRequirements } = require('./native-platform-requirements.cjs');
const { verifyVcRuntimeCoverage } = require('./vc-runtime-coverage.cjs');
const { verifyGezelRuntimeFiles } = require('./gezel-runtime-files.cjs');

exports.default = async (context) => {
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName;
  const arch = require('builder-util').Arch[context.arch];
  const resources =
    platform === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources');
  await verifyGezelRuntimeFiles(path.join(resources, 'app.asar'));
  console.log('[gezel-runtime] Verified inference assets without the full Gezel service');
  await verifyNativePlatformRequirements({
    directory: path.join(resources, 'gezel-native'),
    platform,
    // beforePack admits darwin-x64 only for the final Intel release, staged without engines.
    ...(platform === 'darwin' && arch === 'x64' ? { allowEmpty: true } : {}),
  });
  if (platform === 'win32') {
    const coverage = await verifyVcRuntimeCoverage({
      appOutDir: context.appOutDir,
      runtimeDir: path.join(resources, 'vc-runtime'),
      required: process.env.DOCBLOCKS_VCRUNTIME_REQUIRED === '1',
    });
    console.log(
      coverage.skipped
        ? '[vc-runtime] No runtime staged; skipped import coverage for this local build'
        : `[vc-runtime] Staged runtime covers ${coverage.binariesChecked} binaries for win32-${arch}`,
    );
  }
  await prepareMasGezel(context);
};
