/**
 * Copy Electron's legal files from electron-builder's freshly extracted
 * platform archive into the application resources directory.
 *
 * The npm `electron` package does not guarantee that its optional binary
 * download exists under node_modules/electron/dist. electron-builder always
 * extracts the exact Electron archive it is packaging, so its afterExtract
 * staging tree is the authoritative source for these files.
 *
 * On macOS, electron-builder 26.16 and later move the two files from beside
 * the app bundle into its `Contents/Resources` before this hook runs, so the
 * resources directory is searched too.
 */

const { copyFile, mkdir, readdir, stat } = require('node:fs/promises');
const path = require('node:path');

const LEGAL_FILES = [
  {
    sources: ['LICENSE.electron.txt', 'LICENSE'],
    destination: 'ELECTRON_LICENSE.txt',
  },
  {
    sources: ['LICENSES.chromium.html'],
    destination: 'ELECTRON_THIRD_PARTY_NOTICES.html',
  },
];

async function findExtractedFile(directories, candidates) {
  for (const directory of directories) {
    for (const candidate of candidates) {
      const source = path.join(directory, candidate);
      try {
        if ((await stat(source)).isFile()) {
          return source;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  throw new Error(
    `Electron legal resource is missing from the extracted archive; searched: ${candidates.join(', ')}`,
  );
}

async function findResourcesDirectory(context) {
  const isMac = context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas';
  if (!isMac) {
    return path.join(context.appOutDir, 'resources');
  }

  const appBundles = (await readdir(context.appOutDir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
  );
  if (appBundles.length !== 1) {
    throw new Error(
      `Expected one extracted Electron app bundle, found: ${appBundles.map((entry) => entry.name).join(', ') || 'none'}`,
    );
  }

  return path.join(context.appOutDir, appBundles[0].name, 'Contents', 'Resources');
}

exports.default = async function copyElectronLicenses(context) {
  const resourcesDirectory = await findResourcesDirectory(context);
  const destinationDirectory = path.join(resourcesDirectory, 'licenses');
  await mkdir(destinationDirectory, { recursive: true });

  await Promise.all(
    LEGAL_FILES.map(async ({ sources, destination }) => {
      const source = await findExtractedFile([context.appOutDir, resourcesDirectory], sources);
      await copyFile(source, path.join(destinationDirectory, destination));
    }),
  );
};
