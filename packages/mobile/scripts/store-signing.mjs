import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
// Pure release-signing checks for store-native.mjs. Everything here runs
// without signing material or native SDKs, so the Mocha suite covers it on Linux.
export const APP_ID = 'com.bendyline.docblocks.mobile';
export const STORE_SECRETS = {
  // ANDROID_UPLOAD_KEYSTORE_PATH may replace the base64 secret on a local machine.
  android: [
    'ANDROID_UPLOAD_KEYSTORE_BASE64',
    'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
    'ANDROID_UPLOAD_KEY_ALIAS',
    'ANDROID_UPLOAD_KEY_PASSWORD',
  ],
  ios: [
    'IOS_DISTRIBUTION_CERTIFICATE_BASE64',
    'IOS_DISTRIBUTION_CERTIFICATE_PASSWORD',
    'IOS_PROVISIONING_PROFILE_BASE64',
  ],
};
function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
/** Names of the signing inputs a store build of `platform` still needs. */
export function missingSecrets(platform, env) {
  return STORE_SECRETS[platform].filter(
    (name) =>
      !env[name] &&
      !(name === 'ANDROID_UPLOAD_KEYSTORE_BASE64' && env.ANDROID_UPLOAD_KEYSTORE_PATH),
  );
}
/** Decodes a base64 secret into a private file; Buffer.from alone ignores bad input. */
export function decodeSecret(name, destination, env = process.env) {
  const value = (env[name] ?? '').replace(/\s/gu, '');
  ensure(value, `Missing ${name}.`);
  ensure(
    value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value),
    `${name} must contain a base64-encoded file.`,
  );
  writeFileSync(destination, Buffer.from(value, 'base64'), { mode: 0o600 });
}
/**
 * Accepts only an unexpired App Store Connect profile registered for APP_ID,
 * and returns the one Apple Distribution identity in `identities` (the output
 * of `security find-identity -v -p codesigning`) that the profile authorizes.
 */
export function profileSettings(profile, identities, now = new Date()) {
  ensure(profile.expirationDate > now, 'The iOS provisioning profile has expired.');
  ensure(
    !profile.provisionedDevices?.length && !profile.provisionsAllDevices,
    'Use an App Store Connect profile, not a development, ad hoc, or enterprise profile.',
  );
  const entitlements = profile.entitlements;
  ensure(entitlements['get-task-allow'] !== true, 'Development profiles cannot sign store builds.');
  const team = profile.teamIdentifier[0];
  ensure(
    entitlements['com.apple.developer.team-identifier'] === team,
    'The provisioning profile team is inconsistent.',
  );
  // The App ID prefix can differ from the team ID for older Apple accounts.
  ensure(
    profile.applicationIdentifierPrefix.some(
      (prefix) => entitlements['application-identifier'] === `${prefix}.${APP_ID}`,
    ),
    `The provisioning profile must be explicitly registered for ${APP_ID}.`,
  );
  // Xcode matches PROVISIONING_PROFILE_SPECIFIER against the UUID
  // case-sensitively, and Apple issues lowercase UUIDs: pass it through verbatim.
  ensure(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(profile.uuid),
    'The provisioning profile has no valid UUID.',
  );
  const authorized = new Set(
    profile.developerCertificates.map((der) =>
      createHash('sha1').update(der).digest('hex').toUpperCase(),
    ),
  );
  const matches = [
    ...new Set(
      [...identities.matchAll(/([0-9A-F]{40}) "Apple Distribution: [^"\n]+"/gu)].map(
        (match) => match[1],
      ),
    ),
  ].filter((fingerprint) => authorized.has(fingerprint));
  ensure(
    matches.length === 1,
    'The P12 must contain one valid Apple Distribution identity authorized by the profile.',
  );
  return { team, profile: profile.uuid, certificate: matches[0] };
}
/**
 * Switches only the App target's Release configuration to manual signing.
 * Passing signing settings to xcodebuild globally would also apply them to the
 * Swift package targets, which reject provisioning profiles.
 */
export function configureProject(text, settings) {
  const pattern =
    /(\t\t[0-9A-F]{24} \/\* Release \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;\n(?:[^\n]*\n)*?\t\t\tbuildSettings = \{\n)(.*?)(\t\t\t\};\n\t\t\tname = Release;\n\t\t\};)/gsu;
  let count = 0;
  const result = text.replace(pattern, (match, head, body, tail) => {
    if (!body.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID};`)) return match;
    count += 1;
    let signed = body;
    for (const [key, value] of Object.entries({
      CODE_SIGN_STYLE: 'Manual',
      DEVELOPMENT_TEAM: settings.team,
      CODE_SIGN_IDENTITY: settings.certificate,
      PROVISIONING_PROFILE_SPECIFIER: settings.profile,
    })) {
      signed = signed.replace(new RegExp(`^\\t{4}${key} = [^;]+;\\n`, 'gmu'), '');
      signed += `\t\t\t\t${key} = "${value}";\n`;
    }
    return head + signed + tail;
  });
  ensure(count === 1, 'Expected exactly one DocBlocks App Release configuration.');
  return result;
}
/** ExportOptions for an App Store Connect IPA, written locally; nothing is uploaded. */
export function exportOptions(settings) {
  return {
    method: 'app-store-connect',
    destination: 'export',
    signingStyle: 'manual',
    teamID: settings.team,
    signingCertificate: settings.certificate,
    provisioningProfiles: { [APP_ID]: settings.profile },
    manageAppVersionAndBuildNumber: false,
    uploadSymbols: true,
  };
}
/** Parses `security list-keychains` output so the search list can be restored. */
export function parseKeychains(output) {
  return output
    .split('\n')
    .map((line) => line.trim().replace(/^"(.*)"$/u, '$1'))
    .filter(Boolean);
}
