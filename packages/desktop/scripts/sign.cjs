/**
 * Windows Code Signing Script for electron-builder.
 *
 * Uses signtool.exe with the Azure Trusted Signing dlib for cloud-based
 * HSM signing. Called for each PE (the app .exe and the NSIS installer).
 *
 * Required environment variables (from the GitHub Actions workflow):
 *   TRUSTED_SIGNING_DLIB_PATH     - Path to Azure.CodeSigning.Dlib.dll
 *   TRUSTED_SIGNING_METADATA_PATH - Path to metadata.json
 *
 * Authentication uses DefaultAzureCredential:
 *   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
 *
 * When env vars are not set (local dev), signing is skipped gracefully.
 *
 * Pattern adapted from /Volumes/Bendyline/gh/qualla-internal/app/scripts/sign.js
 */

const { execSync } = require('child_process');
const { existsSync, readdirSync } = require('fs');
const path = require('path');

function findSignTool() {
  const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (existsSync(sdkRoot)) {
    const versions = readdirSync(sdkRoot)
      .filter((d) => d.startsWith('10.'))
      .sort()
      .reverse();
    for (const ver of versions) {
      const candidate = path.join(sdkRoot, ver, 'x64', 'signtool.exe');
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return 'signtool.exe';
}

exports.default = async function sign(configuration) {
  const dlibPath = process.env.TRUSTED_SIGNING_DLIB_PATH;
  const metadataPath = process.env.TRUSTED_SIGNING_METADATA_PATH;

  if (!dlibPath || !metadataPath) {
    console.log(`[sign] Skipping signing (no Trusted Signing SDK): ${configuration.path}`);
    return;
  }

  if (!existsSync(dlibPath)) {
    console.log(`[sign] Skipping signing (dlib not found at ${dlibPath}): ${configuration.path}`);
    return;
  }

  const signtool = findSignTool();
  console.log(`[sign] Signing: ${configuration.path}`);
  console.log(`[sign] Using signtool: ${signtool}`);

  const args = [
    `"${signtool}"`,
    'sign',
    '/v',
    '/fd',
    'SHA256',
    '/tr',
    'http://timestamp.acs.microsoft.com',
    '/td',
    'SHA256',
    '/dlib',
    `"${dlibPath}"`,
    '/dmdf',
    `"${metadataPath}"`,
    `"${configuration.path}"`,
  ];

  try {
    execSync(args.join(' '), { stdio: 'inherit' });
    console.log(`[sign] Signed successfully: ${configuration.path}`);
  } catch (err) {
    console.error(`[sign] Signing failed: ${configuration.path}`);
    throw err;
  }
};
