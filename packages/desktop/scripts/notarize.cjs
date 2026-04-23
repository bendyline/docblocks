/**
 * Post-Sign Hook for electron-builder.
 *
 * macOS: Submits the signed .app bundle to Apple for notarization and
 * staples the ticket. Required for Gatekeeper acceptance on unidentified
 * developer dialogs.
 *
 * Required environment variables for macOS (GitHub Actions secrets):
 *   APPLE_ID             - Apple ID email address
 *   APPLE_ID_PASSWORD    - App-specific password
 *   APPLE_TEAM_ID        - Developer team ID
 *
 * When these are not set (local dev, Windows/Linux CI), this is a no-op.
 *
 * Pattern adapted from /Volumes/Bendyline/gh/qualla-internal/app/scripts/notarize.js
 */

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_ID_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] Skipping notarization (no Apple credentials)');
    return;
  }

  const appBundleId = context.packager.appInfo.id;
  const appPath = context.appOutDir
    ? `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
    : undefined;

  if (!appPath) {
    console.log('[notarize] No app path found, skipping');
    return;
  }

  console.log(`[notarize] Notarizing: ${appPath}`);

  const { notarize: notarizeApp } = require('@electron/notarize');

  await notarizeApp({
    appBundleId,
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log(`[notarize] Notarization complete: ${appPath}`);
};
