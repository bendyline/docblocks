const path = require('node:path');
const { verifyNativeDependencies } = require('./native-dependencies.cjs');
const { default: prepareMasGezel } = require('./prepare-mas-gezel.cjs');
const { verifyNativePlatformRequirements } = require('./native-platform-requirements.cjs');
const { verifyVcRuntimeCoverage } = require('./vc-runtime-coverage.cjs');

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
  const result = await verifyNativeDependencies({
    asarPath: path.join(resources, 'app.asar'),
    platform,
    arch,
  });
  console.log(
    `[native-dependencies] Verified ${result.packages.length} target packages and ${result.binariesChecked} binaries for ${platform}-${arch}`,
  );
  await verifyNativePlatformRequirements({
    directory: path.join(resources, 'gezel-native'),
    platform,
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
